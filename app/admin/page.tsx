import { requireChatGPTUser } from '@/app/chatgpt-auth';
import UploadForm from '@/app/admin/upload-form';
import { allowAdministrator, getReviewSummaries } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await requireChatGPTUser('/admin');
  const isAdmin = await allowAdministrator(user);
  const reviews = isAdmin ? await getReviewSummaries() : [];

  if (!isAdmin) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f7f3] px-5 text-[#17211d]">
        <section className="w-full max-w-lg rounded-3xl border border-[#d9e3da] bg-white p-8 text-center shadow-[0_14px_40px_rgba(31,77,51,0.07)]">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#987020]">访问受限</p>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-[#253e32]">这是管理员管理区</h1>
          <p className="mt-3 text-sm leading-6 text-[#617268]">
            你可以继续浏览团队公开的审查归档；上传和同步管理仅向已登记的管理员开放。
          </p>
          <a
            href="/"
            className="mt-6 inline-flex rounded-lg bg-[#1e6349] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#174d39]"
          >
            返回日志归档
          </a>
        </section>
      </main>
    );
  }

  const latest = reviews[0] ?? null;

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="/" className="text-sm font-bold text-[#245d46]">
            ← 返回日志归档
          </a>
          <span className="rounded-full bg-[#eaf3eb] px-3 py-1.5 text-xs font-semibold text-[#38654c]">
            管理员：{user.displayName}
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#37735a]">管理员工作台</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-[#1b382b]">
          管理审查日志，而不打断日常开发。
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5d6e64]">
          自动同步会按来源路径更新同一份日志；需要补录或更正时，可直接上传 Markdown 文件，保留原始阅读格式。
        </p>

        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          <StatusCard label="已归档日志" value={reviews.length + ' 份'} />
          <StatusCard label="最近审查日期" value={latest?.logDate ?? '暂无'} />
          <StatusCard label="自动同步状态" value="部署后启用" />
        </div>

        <section className="mt-8 rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_12px_34px_rgba(31,77,51,0.05)] sm:p-8">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">手工补录 / 更正</p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-[#243e31]">上传审查日志 Markdown</h2>
            <p className="mt-2 text-sm leading-6 text-[#66766d]">
              同名文件再次上传会更新对应的管理员上传记录；自动同步记录仍会按原运行目录进行去重。
            </p>
          </div>
          <UploadForm />
        </section>

        <section className="mt-8 rounded-3xl border border-[#d8e4d9] bg-[#edf6ee] p-6 sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4a8066]">每日自动同步</p>
          <h2 className="mt-1 text-xl font-black tracking-tight text-[#244333]">与“SVN 当日提交审查”保持同频</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#5a7060]">
            网站发布后，现有自动化会在成功生成日志后调用同步程序。同步异常不会影响 SVN 更新、实体生成、构建或审查结论，管理员仍可在这里手工补录。
          </p>
        </section>
      </div>
    </main>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#d5e2d6] bg-white p-5">
      <p className="text-xs font-semibold text-[#748278]">{label}</p>
      <p className="mt-2 text-lg font-black text-[#28503c]">{value}</p>
    </div>
  );
}
