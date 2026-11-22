// Adjust a small set of common Japanese sentence endings, keeping the rest
// of the wording, punctuation, links and hashtags in place.
export function softenThreadsEnding(text: string): string {
  return text
    .replace(/(してください)(?=[。！!\n]|$)/g, 'してみてください')
    .replace(/(?<!してみて)ください(?=[。！!\n]|$)/g, 'くださいね')
    .replace(/と思います(?=[。！!\n]|$)/g, 'と感じています')
    .replace(/でしょうか(?=[。？?\n]|$)/g, 'ですか');
}

// AddEditModal accepts HTML. Escape external plain text before using it as a
// composer seed, so brackets and tags in the original remain visible text.
export function threadsCopyTextToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map(
      (line) =>
        '<p>' +
        line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;') +
        '</p>'
    )
    .join('');
}
