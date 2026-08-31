type Props = {
  action: string;
};

export default function HomeQuickSearch({ action }: Props) {
  return (
    <form action={action} method="get" role="search" className="home-quick-search">
      <div>
        <p className="text-sm font-black text-[#243e31]">快速查找问题</p>
        <p className="mt-1 text-xs text-[#718077]">按关键词、Revision 或日志日期直接进入问题看板。</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label>关键词<input name="q" aria-label="快捷关键词" placeholder="问题、模块或说明" /></label>
        <label>Revision<input name="revision" inputMode="numeric" aria-label="快捷 Revision" placeholder="例如 53734" /></label>
        <label>日志日期<input name="from" type="date" aria-label="快捷日期" /></label>
      </div>
      <button type="submit" className="filter-apply mt-4">查询问题 →</button>
    </form>
  );
}
