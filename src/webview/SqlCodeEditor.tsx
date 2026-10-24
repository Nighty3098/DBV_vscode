import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { sql } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';
import { statementAtCursor } from '../core/queryBuilder';

export interface SqlEditorHandle {
  getSelectionOrCurrent(): string;
  getAll(): string;
  focus(): void;
}

interface Props {
  value: string;
  onChange?: (value: string) => void;
  onRun: (sql: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  placeholder?: string;
}

const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--vscode-editor-foreground)',
    backgroundColor: 'var(--vscode-editor-background)',
    height: '100%',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--vscode-editor-font-family)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
    color: 'var(--vscode-editorLineNumber-foreground)',
    border: 'none',
    borderRight: '1px solid var(--vscode-panel-border)',
    paddingLeft: '0',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground)' },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)' },
  '.cm-line': { paddingLeft: '0', paddingRight: '0' },
});

const vscodeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--vscode-symbolIcon-keywordForeground, var(--vscode-textLink-foreground, var(--vscode-editor-foreground)))' },
  { tag: tags.operator, color: 'var(--vscode-editor-foreground)' },
  { tag: tags.string, color: 'var(--vscode-debugTokenExpression-string, var(--vscode-editor-foreground))' },
  { tag: tags.number, color: 'var(--vscode-debugTokenExpression-number, var(--vscode-editor-foreground))' },
  { tag: tags.bool, color: 'var(--vscode-editorWarning-foreground, var(--vscode-editor-foreground))' },
  { tag: tags.null, color: 'var(--vscode-editorWarning-foreground, var(--vscode-editor-foreground))' },
  { tag: tags.comment, color: 'var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground))', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: 'var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground, var(--vscode-editor-foreground)))' },
  { tag: tags.typeName, color: 'var(--vscode-symbolIcon-classForeground, var(--vscode-textLink-foreground, var(--vscode-editor-foreground)))' },
  { tag: tags.variableName, color: 'var(--vscode-editor-foreground)' },
  { tag: tags.propertyName, color: 'var(--vscode-editor-foreground)' },
  { tag: tags.punctuation, color: 'var(--vscode-editor-foreground)' },
]);

export const SqlCodeEditor = forwardRef<SqlEditorHandle, Props>(function SqlCodeEditor(
  { value, onChange, onRun, onSave, readOnly, placeholder },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingRef = useRef(false);
  const callbacks = useRef({ onChange, onRun, onSave });
  callbacks.current = { onChange, onRun, onSave };
  const initialValue = useRef(value);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: initialValue.current,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(vscodeHighlightStyle),
        bracketMatching(),
        highlightActiveLine(),
        sql(),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': placeholder ?? 'SQL editor', spellcheck: 'false' }),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: (view) => {
              const selection = view.state.selection.main;
              const text = selection.empty
                ? statementAtCursor(view.state.doc.toString(), selection.head)
                : view.state.sliceDoc(selection.from, selection.to);
              if (text.trim()) callbacks.current.onRun(text);
              return true;
            },
          },
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              callbacks.current.onSave?.();
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingRef.current) {
            callbacks.current.onChange?.(update.state.doc.toString());
          }
        }),
        EditorView.editable.of(!readOnly),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [placeholder, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    syncingRef.current = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    syncingRef.current = false;
  }, [value]);

  useImperativeHandle(ref, () => ({
    getSelectionOrCurrent() {
      const view = viewRef.current;
      if (!view) return '';
      const selection = view.state.selection.main;
      if (!selection.empty) return view.state.sliceDoc(selection.from, selection.to);
      return statementAtCursor(view.state.doc.toString(), selection.head);
    },
    getAll() {
      return viewRef.current?.state.doc.toString() ?? '';
    },
    focus() {
      viewRef.current?.focus();
    },
  }), []);

  return <div className="sql-editor" ref={hostRef} />;
});
