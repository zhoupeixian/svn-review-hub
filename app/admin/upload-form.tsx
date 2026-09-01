'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function UploadForm({ uploadApiPath }: { uploadApiPath: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setStatus('请先选择一份 .md 审查日志。');
      return;
    }

    setIsSubmitting(true);
    setStatus('');
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(uploadApiPath, {
        method: 'POST',
        body: formData,
      });
      const body = (await response.json()) as { error?: string; review?: { logDate: string } };
      if (!response.ok) {
        setStatus(body.error ?? '上传失败，请稍后重试。');
        return;
      }

      setStatus('已导入 ' + (body.review?.logDate ?? '该') + ' 的审查日志。');
      setFile(null);
      router.refresh();
    } catch {
      setStatus('网络请求失败，请检查连接后重试。');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6">
      <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-[#9bbca3] bg-[#fbfefb] px-5 py-9 text-center hover:bg-[#f3faf4]">
        <span className="text-2xl" aria-hidden="true">⇧</span>
        <span className="mt-2 text-sm font-bold text-[#2f6249]">
          {file ? file.name : '选择或拖入 .md 审查日志'}
        </span>
        <span className="mt-1 text-xs text-[#748279]">仅管理员可上传，单个文件最大 2MB。</span>
        <input
          type="file"
          accept=".md,text/markdown"
          className="sr-only"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!file || isSubmitting}
          className="rounded-lg bg-[#1e6349] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#174d39] disabled:cursor-not-allowed disabled:bg-[#a9bdae]"
        >
          {isSubmitting ? '正在导入…' : '导入日志'}
        </button>
        {status && (
          <p role="status" className="text-sm text-[#526c5b]">
            {status}
          </p>
        )}
      </div>
    </form>
  );
}
