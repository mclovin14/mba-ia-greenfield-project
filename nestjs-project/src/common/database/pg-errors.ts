import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

interface PgDriverErrorFields {
  code?: unknown;
  detail?: unknown;
}

export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgDriverErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
