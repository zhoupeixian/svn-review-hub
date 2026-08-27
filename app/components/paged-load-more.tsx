'use client';

type Props = {
  hasMore: boolean;
  loading: boolean;
  label: string;
  onLoad: () => void;
};

export default function PagedLoadMore({ hasMore, loading, label, onLoad }: Props) {
  return (
    <div className="mt-6 text-center">
      {hasMore ? (
        <button type="button" disabled={loading} onClick={onLoad} className="rounded-lg border border-[#b9cbbb] bg-white px-4 py-2.5 text-sm font-bold text-[#1d5b46] hover:bg-[#edf4ee] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d5b46] disabled:cursor-wait disabled:opacity-60">
          {loading ? '正在加载…' : label}
        </button>
      ) : (
        <p role="status" className="text-sm text-[#718077]">已加载全部结果</p>
      )}
    </div>
  );
}
