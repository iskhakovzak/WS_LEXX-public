/** Save a URL (object URL or same-origin link) as a file named `filename`. */
export function downloadBlob(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
}
