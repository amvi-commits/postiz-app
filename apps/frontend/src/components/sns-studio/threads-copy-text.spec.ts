import {
  softenThreadsEnding,
  threadsCopyTextToHtml,
} from './threads/threads-copy-text';

describe('Threads copy draft text', () => {
  it('only changes supported endings and preserves links, hashtags and line breaks', () => {
    expect(
      softenThreadsEnding(
        '確認してください。\n大切だと思います。\nhttps://example.com #Threads'
      )
    ).toBe(
      '確認してみてください。\n大切だと感じています。\nhttps://example.com #Threads'
    );
  });

  it('leaves unsupported phrasing in place and can be applied more than once', () => {
    expect(softenThreadsEnding('新しい写真をアップしました！')).toBe(
      '新しい写真をアップしました！'
    );
    expect(softenThreadsEnding(softenThreadsEnding('確認してください。'))).toBe(
      '確認してみてください。'
    );
  });

  it('handles angle brackets and line breaks as plain text in the composer', () => {
    expect(threadsCopyTextToHtml('<p>&内容</p>\r\n\r\n2行目')).toBe(
      '<p>&lt;p&gt;&amp;内容&lt;/p&gt;</p><p></p><p>2行目</p>'
    );
  });
});
