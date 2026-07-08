export interface BookResult {
  id: string;
  title: string;
  author: string;
  source: string;
  downloadUrl: string;
  fileSize?: number;
  language?: string;
  coverUrl?: string;
  description?: string;
  year?: number;
  formats?: Record<string, string>;
}

export interface Source {
  readonly name: string;
  search(query: string, limit?: number): Promise<BookResult[]>;
  download(book: BookResult): Promise<Buffer>;
}

export interface SearchOptions {
  limit?: number;
  sources?: string[];
}
