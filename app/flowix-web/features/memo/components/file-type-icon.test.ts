import { describe, expect, it } from 'vitest';
import {
  FileCodeIcon,
  FileDocIcon,
  FileHtmlIcon,
  FileImageIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
} from '@phosphor-icons/react';

import { getFileIcon } from '@features/memo/components/file-type-icon';

describe('getFileIcon', () => {
  it.each([
    ['README.MD', FileMdIcon],
    ['index.html', FileHtmlIcon],
    ['app.tsx', FileCodeIcon],
    ['photo.JPEG', FileImageIcon],
    ['report.docx', FileDocIcon],
    ['slides.pptx', FilePptIcon],
    ['recording.mp4', FileVideoIcon],
    ['archive.zip', FileZipIcon],
    ['budget.xlsx', FileXlsIcon],
    ['manual.pdf', FilePdfIcon],
  ])('maps %s to its file icon', (filename, expectedIcon) => {
    expect(getFileIcon(filename)).toBe(expectedIcon);
  });

  it('uses a generic file icon for unknown extensions', () => {
    // Extensionless text files are opened by CodeMirror (LICENSE, Makefile,
    // Dockerfile), while a binary-looking extension remains generic.
    expect(getFileIcon('LICENSE')).toBe(FileCodeIcon);
    expect(getFileIcon('data.bin')).toBe(FileTextIcon);
  });
});
