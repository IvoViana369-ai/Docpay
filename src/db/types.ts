/** O mínimo que o DocPay usa de um banco PostgreSQL, para não depender de um driver só. */
export interface Queryable {
  /** Um comando SQL com parâmetros $1, $2... Devolve as linhas. */
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Vários comandos SQL de uma vez, sem parâmetros. Serve às migrações. */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /**
   * Roda fn numa transação do banco: confirma se tudo der certo e desfaz
   * tudo se algo falhar. Dentro de fn, use só o `tx` recebido.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
