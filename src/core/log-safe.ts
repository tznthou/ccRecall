/** Strip control chars from an error message before logging.
 *  DB/indexer/FTS5/chokidar errors can embed memory content or user-supplied
 *  paths verbatim; newlines or ANSI escapes in those strings would corrupt log
 *  output and defeat downstream log scrapers. */
export function scrubErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-control-regex
  return msg.replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
}
