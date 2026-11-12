// The daily group post. Admins fill a queue; one item goes out per scheduled run.
import type { Bot } from './bot.js'

type Item = { id: number; text: string; media: string | null }

export function enqueue(bot: Bot, text: string, media?: string | null): number {
  bot.db.run('INSERT INTO content_queue (text, media, created_at) VALUES (?, ?, ?)', text, media ?? null, bot.now())
  return pending(bot).length
}

export const pending = (bot: Bot) => bot.db.all<Item>('SELECT * FROM content_queue WHERE posted_at IS NULL ORDER BY id')

/** Post the oldest queued item to the group. Does nothing when the queue is empty. */
export async function postNext(bot: Bot): Promise<boolean> {
  const item = pending(bot)[0]
  if (!item) return false
  await bot.t.postToGroup(item.text, item.media)
  bot.db.run('UPDATE content_queue SET posted_at = ? WHERE id = ?', bot.now(), item.id)
  return true
}
