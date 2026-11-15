import localFont from 'next/font/local';

// Same family/styles as the existing UI, bundled so production builds do not
// depend on a Google Fonts response or a runtime-container font extraction.
export const jakartaSans = localFont({
  src: [
    { path: './PlusJakartaSans.ttf', weight: '500 700', style: 'normal' },
    { path: './PlusJakartaSans-Italic.ttf', weight: '500 700', style: 'italic' },
  ],
  display: 'swap',
});
