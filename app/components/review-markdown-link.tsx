import type { AnchorHTMLAttributes } from 'react';
import { defaultUrlTransform } from 'react-markdown';
import { projectRelativePath } from '../../lib/project-paths';

type MarkdownLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown };

export default function ReviewMarkdownLink({ href = '', children, node: _node, ...props }: MarkdownLinkProps) {
  void _node;
  const relativePath = projectRelativePath(href);
  if (relativePath) {
    return <span className="local-path-hint" data-local-path="true" title={relativePath}>{children}</span>;
  }
  return <a {...props} href={href}>{children}</a>;
}

export function reviewMarkdownUrlTransform(url: string): string {
  return projectRelativePath(url) ? url : defaultUrlTransform(url);
}
