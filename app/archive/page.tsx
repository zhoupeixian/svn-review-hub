import { redirect } from 'next/navigation';
import { legacyProjectPath } from '@/lib/project-routes';

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LegacyArchivePage({ searchParams }: Props) {
  redirect(legacyProjectPath('/archive', await searchParams));
}
