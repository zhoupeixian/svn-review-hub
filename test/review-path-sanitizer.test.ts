import { describe, expect, it } from 'vitest';
import {
  findAbsoluteLocalPath,
  reviewFilePathFromUrl,
  sanitizeReviewMarkdown,
} from '../lib/review-path-sanitizer.js';

describe('审查日志路径脱敏', () => {
  it('按任意 Windows 项目根目录转换正文和 Markdown 本地链接', () => {
    const markdown = [
      '# 日志',
      '文件：E:\\workspace\\haihua\\src\\order\\OrderService.java:82',
      '[打开源码](<E:/workspace/haihua/src/order/Order Service.java:82>)',
    ].join('\n');

    const sanitized = sanitizeReviewMarkdown(
      markdown,
      'E:\\workspace\\haihua',
    );

    expect(sanitized).toContain(
      '文件：src\\order\\OrderService.java:82',
    );
    expect(sanitized).not.toContain('E:\\workspace\\haihua');
    expect(sanitized).not.toContain('E:/workspace/haihua');
    const href = sanitized.match(/review-file:[^>)]+/)?.[0];
    expect(href).toBeTruthy();
    expect(reviewFilePathFromUrl(href!)).toBe(
      'src/order/Order Service.java:82',
    );
  });

  it('支持 Unix 项目根目录且不要求日志位于项目目录', () => {
    const sanitized = sanitizeReviewMarkdown(
      '文件：/srv/work trees/finance/src/report.ts:120',
      '/srv/work trees/finance',
    );
    expect(sanitized).toBe('文件：src/report.ts:120');
  });

  it('拒绝项目根目录之外仍残留的绝对本地路径', () => {
    expect(() =>
      sanitizeReviewMarkdown(
        '文件：D:\\other\\secret.txt',
        'D:\\SVN\\ZHERP',
      ),
    ).toThrow('项目根目录之外的绝对本地路径');
  });

  it('识别服务端不得持久化的绝对本地路径', () => {
    expect(findAbsoluteLocalPath('x C:\\Users\\dev\\secret.txt')).toContain(
      'C:\\Users\\dev',
    );
    expect(findAbsoluteLocalPath('x file:///home/dev/project/a.ts')).toContain(
      'file:///home/dev/project/a.ts',
    );
    expect(findAbsoluteLocalPath('src/order/a.ts:1')).toBeNull();
  });

  it('拒绝磁盘根目录或非绝对项目根目录配置', () => {
    expect(() => sanitizeReviewMarkdown('x', 'C:\\')).toThrow(
      'REVIEW_PROJECT_ROOT',
    );
    expect(() => sanitizeReviewMarkdown('x', 'relative/project')).toThrow(
      'REVIEW_PROJECT_ROOT',
    );
  });
});
