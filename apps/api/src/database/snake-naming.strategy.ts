import { DefaultNamingStrategy, NamingStrategyInterface, Table } from 'typeorm';
import { snakeCase } from 'typeorm/util/StringUtils';

/** Forces snake_case for every table, column, relation and join column (AGENTS.md 6.1). */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override tableName(targetName: string, userSpecifiedName: string | undefined): string {
    return userSpecifiedName ?? snakeCase(targetName);
  }

  override columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    if (embeddedPrefixes.length > 0) {
      return snakeCase(`${embeddedPrefixes.join('_')}_${customName ?? propertyName}`);
    }
    return customName ?? snakeCase(propertyName);
  }

  override relationName(propertyName: string): string {
    return snakeCase(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snakeCase(`${relationName}_${referencedColumnName}`);
  }

  override joinTableName(firstTableName: string, secondTableName: string): string {
    return snakeCase(`${firstTableName}_${secondTableName}`);
  }

  override joinTableColumnName(tableName: string, propertyName: string, columnName?: string): string {
    return snakeCase(`${tableName}_${columnName ?? propertyName}`);
  }

  classTableInheritanceParentColumnName(parentTableName: string, parentTableIdPropertyName: string): string {
    return snakeCase(`${parentTableName}_${parentTableIdPropertyName}`);
  }

  eagerJoinRelationAlias(alias: string, propertyPath: string): string {
    return `${alias}__${propertyPath.replace('.', '_')}`;
  }

  override uniqueConstraintName(tableOrName: Table | string, columnNames: string[]): string {
    const tableName = typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
    return `${tableName}_${columnNames.join('_')}_unique`;
  }
}
