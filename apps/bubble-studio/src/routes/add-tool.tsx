import { createFileRoute } from '@tanstack/react-router';
import { AddToolPage } from '@/pages/AddToolPage';

export const Route = createFileRoute('/add-tool')({
  component: AddToolPage,
});
