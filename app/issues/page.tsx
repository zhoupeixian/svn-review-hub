import { redirect } from 'next/navigation';
import { legacyProjectPath } from '@/lib/project-routes';

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LegacyIssuesPage({ searchParams }: Props) {
  redirect(legacyProjectPath('/issues', await searchParams));
}
