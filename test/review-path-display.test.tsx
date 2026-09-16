/// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ReviewMarkdownLink from '../app/components/review-markdown-link';
import {
  projectRelativePath,
  relativizeProjectPaths,
  sanitizeStoredReviewMarkdown,
  sanitizeStoredReviewText,
} from '../lib/project-paths';

describe('项目路径展示', () => {
  it('渲染同步端生成的相对文件引用但不创建网页链接', () => {
    const href = 'review-file:' + encodeURIComponent('src/order/Order Service.java:42');
    expect(projectRelativePath(href)).toBe('src/order/Order Service.java:42');

    render(
      <ReviewMarkdownLink href={href}>Order Service.java</ReviewMarkdownLink>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    const hint = screen.getByText('Order Service.java');
    expect(hint.getAttribute('title')).toBe('src/order/Order Service.java:42');
    expect(hint.getAttribute('data-local-path')).toBe('true');
  });

  it('结构化问题详情保留纯文本排版并显示可读的本地路径', () => {
    const relativePath =
      'erp-sinochem-biz/src/main/java-sinochem-toolconfig/com/bokesoft/erpsinochem/tool/co/TCO_GenCostCompStructPrice.java#L83';
    const detail =
      '- 相关文件： [TCO_GenCostCompStructPrice.java](<review-file:' +
      encodeURIComponent(relativePath) +
      '>)\n- 影响： 保留原有说明';

    expect(sanitizeStoredReviewText(detail, 'sinochem')).toBe(
      '- 相关文件： [TCO_GenCostCompStructPrice.java](<' +
        relativePath +
        '>)\n- 影响： 保留原有说明',
    );
  });

  it('只为历史 zherp 数据保留旧绝对路径展示兼容', () => {
    const historical = '相关文件：D:\\SVN\\ZHERP\\solutions\\erp\\Form.xml:633';
    expect(relativizeProjectPaths(historical)).toBe(
      '相关文件：solutions/erp/Form.xml:633',
    );
    expect(sanitizeStoredReviewText(historical, 'zherp')).toBe(
      '相关文件：solutions/erp/Form.xml:633',
    );
    expect(sanitizeStoredReviewText(historical, 'haihua')).toBe(historical);
    expect(sanitizeStoredReviewMarkdown(historical, 'zherp')).not.toContain('D:\\SVN\\ZHERP');
  });

  it('正常 HTTP 链接保持可点击', () => {
    render(
      <ReviewMarkdownLink href="https://example.com/review">reference</ReviewMarkdownLink>,
    );
    expect(
      screen.getByRole('link', { name: 'reference' }).getAttribute('href'),
    ).toBe('https://example.com/review');
  });
});
