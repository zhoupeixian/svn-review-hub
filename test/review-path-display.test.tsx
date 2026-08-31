/// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ReviewMarkdownLink from '../app/components/review-markdown-link';
import { projectRelativePath, relativizeProjectPaths } from '../lib/project-paths';

describe('项目路径展示', () => {
  it('将项目根目录下的正反斜杠路径转为相对路径并保留行号', () => {
    expect(projectRelativePath('D:\\SVN\\ZHERP\\solutions\\erp\\Form.xml:633')).toBe('solutions/erp/Form.xml:633');
    expect(projectRelativePath('D:/SVN/ZHERP/solutions/erp/Form.xml:6723-6728')).toBe('solutions/erp/Form.xml:6723-6728');
    expect(projectRelativePath('https://example.com/D:/SVN/ZHERP/file.xml')).toBeNull();
  });

  it('将结构化问题详情中的绝对路径替换为相对路径', () => {
    expect(relativizeProjectPaths('相关文件：D:\\SVN\\ZHERP\\solutions\\erp\\Form.xml:633\n证据保留')).toBe(
      '相关文件：solutions/erp/Form.xml:633\n证据保留',
    );
  });

  it('项目本地链接不可点击，但保留链接样式和相对路径提示', () => {
    render(<ReviewMarkdownLink href="D:/SVN/ZHERP/solutions/erp/BusinessSettingRegister_FI.java:42">BusinessSettingRegister_FI.java</ReviewMarkdownLink>);
    expect(screen.queryByRole('link')).toBeNull();
    const hint = screen.getByText('BusinessSettingRegister_FI.java');
    expect(hint.getAttribute('title')).toBe('solutions/erp/BusinessSettingRegister_FI.java:42');
    expect(hint.getAttribute('data-local-path')).toBe('true');
  });

  it('正常 HTTP 链接保持可点击', () => {
    render(<ReviewMarkdownLink href="https://example.com/review">reference</ReviewMarkdownLink>);
    expect(screen.getByRole('link', { name: 'reference' }).getAttribute('href')).toBe('https://example.com/review');
  });
});
