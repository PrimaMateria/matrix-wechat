export * from "wechat-rpc/types";

export interface Database {
  id: string;
  path: string;
  readable: boolean;
  active?: boolean;
  encrypted: boolean;
  error?: string;
}
export interface NativeDB {
  databases(): Promise<Database[]>;
  query(
    id: string,
    sql: string,
    limit: number,
  ): Promise<{ columns: string[]; rows: any[][]; truncated: boolean }>;
}
