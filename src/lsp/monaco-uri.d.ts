// monaco-editor ships this module as plain JavaScript with no adjacent `.d.ts`,
// and its exports map does not publish the subpath, so `uri.test.ts` reaches it
// by relative path. Without this declaration that import is an implicit `any`,
// which `strict` rejects.
//
// Only the surface the test uses is declared. The point of importing the real
// module is to check `pathToUri` against Monaco's own encoder rather than
// against a copy of what it was believed to do, so this must stay a declaration
// over the real implementation and never become a stub.
declare module "*/monaco-editor/esm/vs/base/common/uri.js" {
  export class URI {
    static parse(value: string, strict?: boolean): URI;
    static file(path: string): URI;
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    toString(skipEncoding?: boolean): string;
  }
}
