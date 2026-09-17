import { ensureSeed } from './bootstrap';

export default async function globalSetup(): Promise<void> {
  await ensureSeed();
}
