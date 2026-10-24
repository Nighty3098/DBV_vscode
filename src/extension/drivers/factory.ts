import type { ConnectionConfig, DatabaseType } from '../../shared/types';
import type { Driver } from './base';
import { SqliteDriver } from './sqlite';
import { PostgresDriver } from './postgres';
import { MysqlDriver } from './mysql';
import { MssqlDriver } from './mssql';

export interface DriverFactory {
  create(config: ConnectionConfig, password: string): Driver;
}

export const defaultDriverFactory: DriverFactory = {
  create(config, password) {
    switch (config.type) {
      case 'sqlite':
        return new SqliteDriver(config);
      case 'postgres':
        return new PostgresDriver(config, { password });
      case 'mysql':
      case 'mariadb':
        return new MysqlDriver(config, password);
      case 'mssql':
        return new MssqlDriver(config, password);
      default:
        throw new Error(`Unsupported database type: ${String(config.type as DatabaseType)}`);
    }
  },
};
