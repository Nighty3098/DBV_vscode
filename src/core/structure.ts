import type {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  TableRef,
  TableStructure,
} from '../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringList(
  value: unknown,
  field: string,
  malformedFields: string[],
): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }

  malformedFields.push(field);
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (isRecord(value)) {
    return Object.values(value).filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function normalizeColumn(value: unknown, index: number, malformedFields: string[]): ColumnInfo | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.dataType !== 'string') {
    malformedFields.push(`columns[${index}]`);
    return undefined;
  }
  if (
    typeof value.nullable !== 'boolean' ||
    (value.defaultValue !== null && typeof value.defaultValue !== 'string') ||
    typeof value.primaryKey !== 'boolean' ||
    typeof value.autoIncrement !== 'boolean' ||
    typeof value.ordinal !== 'number'
  ) {
    malformedFields.push(`column "${value.name}" metadata`);
  }
  return {
    name: value.name,
    dataType: value.dataType,
    nullable: value.nullable === true,
    defaultValue: typeof value.defaultValue === 'string' ? value.defaultValue : null,
    primaryKey: value.primaryKey === true,
    autoIncrement: value.autoIncrement === true,
    ordinal: typeof value.ordinal === 'number' ? value.ordinal : index + 1,
  };
}

function normalizeIndex(
  value: unknown,
  position: number,
  malformedFields: string[],
): IndexInfo | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') {
    malformedFields.push(`indexes[${position}]`);
    return undefined;
  }
  if (typeof value.unique !== 'boolean' || typeof value.primary !== 'boolean') {
    malformedFields.push(`index "${value.name}" flags`);
  }
  return {
    name: value.name,
    columns: normalizeStringList(value.columns, `index "${value.name}".columns`, malformedFields),
    unique: value.unique === true,
    primary: value.primary === true,
  };
}

function normalizeForeignKey(
  value: unknown,
  position: number,
  malformedFields: string[],
): ForeignKeyInfo | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') {
    malformedFields.push(`foreignKeys[${position}]`);
    return undefined;
  }
  if (typeof value.referencedTable !== 'string') {
    malformedFields.push(`foreign key "${value.name}".referencedTable`);
  }
  return {
    name: value.name,
    columns: normalizeStringList(value.columns, `foreign key "${value.name}".columns`, malformedFields),
    referencedSchema: typeof value.referencedSchema === 'string' ? value.referencedSchema : undefined,
    referencedTable: typeof value.referencedTable === 'string' ? value.referencedTable : '',
    referencedColumns: normalizeStringList(
      value.referencedColumns,
      `foreign key "${value.name}".referencedColumns`,
      malformedFields,
    ),
    onDelete: typeof value.onDelete === 'string' ? value.onDelete : undefined,
    onUpdate: typeof value.onUpdate === 'string' ? value.onUpdate : undefined,
  };
}

export function normalizeStructureLists(
  value: unknown,
  fallbackTable: TableRef,
): { structure: TableStructure; malformedFields: string[] } {
  const malformedFields: string[] = [];
  if (!isRecord(value)) {
    return {
      structure: {
        table: fallbackTable,
        columns: [],
        indexes: [],
        foreignKeys: [],
        primaryKey: [],
        rowIdAvailable: false,
      },
      malformedFields: ['structure'],
    };
  }

  const collection = (field: 'columns' | 'indexes' | 'foreignKeys'): unknown[] => {
    if (Array.isArray(value[field])) return value[field];
    malformedFields.push(field);
    return [];
  };
  if (typeof value.rowIdAvailable !== 'boolean') malformedFields.push('rowIdAvailable');
  const table = isRecord(value.table) &&
    typeof value.table.name === 'string' &&
    (value.table.type === 'table' || value.table.type === 'view')
    ? (value.table as unknown as TableRef)
    : fallbackTable;
  if (table === fallbackTable && value.table !== fallbackTable) malformedFields.push('table');

  return {
    structure: {
      table,
      columns: collection('columns')
        .map((column, index) => normalizeColumn(column, index, malformedFields))
        .filter((column): column is ColumnInfo => column !== undefined),
      indexes: collection('indexes')
        .map((index, position) => normalizeIndex(index, position, malformedFields))
        .filter((index): index is IndexInfo => index !== undefined),
      foreignKeys: collection('foreignKeys')
        .map((foreignKey, position) => normalizeForeignKey(foreignKey, position, malformedFields))
        .filter((foreignKey): foreignKey is ForeignKeyInfo => foreignKey !== undefined),
      primaryKey: normalizeStringList(value.primaryKey, 'primaryKey', malformedFields),
      rowIdAvailable: value.rowIdAvailable === true,
      ddl: typeof value.ddl === 'string' ? value.ddl : undefined,
    },
    malformedFields,
  };
}
