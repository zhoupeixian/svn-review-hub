import { redirect } from 'next/navigation';
import { legacyProjectPath } from '@/lib/project-routes';

export default function LegacyAdminPage() {
  redirect(legacyProjectPath('/admin'));
}
