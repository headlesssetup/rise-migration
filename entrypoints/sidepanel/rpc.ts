// Thin typed wrapper over runtime messaging to the background worker.

import type { BackgroundRequest, BackgroundResponse } from '@/shared/messaging';

export async function rpc(req: BackgroundRequest): Promise<BackgroundResponse> {
  return (await browser.runtime.sendMessage(req)) as BackgroundResponse;
}
