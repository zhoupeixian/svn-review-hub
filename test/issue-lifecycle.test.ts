import { describe, expect, it } from 'vitest';
import { parseIssueUpdateInput } from '../lib/issue-lifecycle';

describe('parseIssueUpdateInput', () => {
  it('解析已解决的问题更新', () => {
    expect(
      parseIssueUpdateInput({
        status: 'resolved',
        note: '已在 r53701 修复',
        version: 3,
      }),
    ).toEqual({ status: 'resolved', note: '已在 r53701 修复', version: 3 });
  });

  it('拒绝不支持的问题状态', () => {
    expect(() =>
      parseIssueUpdateInput({ status: 'closed', note: '', version: 1 }),
    ).toThrow('不支持的问题状态');
  });

  it('要求非空状态和非负整数版本号', () => {
    expect(() =>
      parseIssueUpdateInput({ status: '', note: '', version: 1 }),
    ).toThrow('问题状态不能为空');
    expect(() =>
      parseIssueUpdateInput({ status: 'open', note: '', version: -1 }),
    ).toThrow('版本号必须为非负整数');
  });

  it('拒绝超过 1000 个字符的说明', () => {
    expect(() =>
      parseIssueUpdateInput({ status: 'open', note: 'a'.repeat(1001), version: 0 }),
    ).toThrow('问题说明不能超过1000个字符');
  });
});
