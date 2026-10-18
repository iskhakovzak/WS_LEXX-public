/**
 * SheetJS entry point for the PropReports parsers.
 *
 * The package is the official SheetJS CE build (cdn.sheetjs.com tarball, pinned in package.json), not the
 * abandoned npm `xlsx@0.18.5`. Its ESM build has no default export and does not load codepage tables on its
 * own (the old CJS build did), so the tables are registered here to keep XLS (BIFF) decoding identical.
 */
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

XLSX.set_cptable(cptable);

export default XLSX;
export type { CellObject, WorkBook, WorkSheet } from "xlsx";
