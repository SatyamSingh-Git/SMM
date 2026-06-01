import { prisma } from "@smm/db";
import { decryptToken } from "../crypto.js";
import {
  fetchConversation,
  listMyPosts,
  type ThreadsConversationNode,
} from "../publishers/threads.js";

// Walks the user's Threads history and extracts every (comment, my_reply)
// pair. Stored as StyleExample rows and later passed as few-shot context
// to the reply generator so the agent mimics the user's actual voice.

export type LearnResult = {
  scannedPosts: number;
  pairsFound: number;
  inserted: number;
  duplicates: number;
};

export async function learnThreadsStyle(opts?: { postLimit?: number }): Promise<LearnResult> {
  const result: LearnResult = {
    scannedPosts: 0,
    pairsFound: 0,
    inserted: 0,
    duplicates: 0,
  };

  const account = await prisma.account.findFirst({ where: { platform: "threads" } });
  if (!account) return result;
  const token = decryptToken(account.accessTokenEncrypted);

  // Threads API sometimes returns conversation nodes with only `username` /
  // `from.username` and a missing `from.id` (older replies, certain endpoints).
  // We match on EITHER id or username so our own replies are reliably found.
  const ourUsername = account.username?.toLowerCase() ?? null;
  const isOurs = (n: ThreadsConversationNode): boolean => {
    if (n.from?.id === account.platformUserId) return true;
    const u = (n.from?.username ?? n.username ?? "").toLowerCase();
    return u !== "" && ourUsername !== null && u === ourUsername;
  };

  // Scan the user's recent posts. 100 is plenty for style — diminishing
  // returns past that, and Threads API rate limits apply.
  const posts = await listMyPosts(account.platformUserId, token, {
    limit: opts?.postLimit ?? 100,
  });
  result.scannedPosts = posts.length;

  for (const post of posts) {
    let nodes: ThreadsConversationNode[];
    try {
      nodes = await fetchConversation(post.id, token);
    } catch (e) {
      console.error(
        `[learn-style] fetchConversation ${post.id} failed:`,
        (e as Error).message
      );
      continue;
    }

    // Build a parent lookup so we can find what each reply was answering.
    const byId = new Map<string, ThreadsConversationNode>();
    for (const n of nodes) byId.set(n.id, n);

    // For every reply BY us, the parent is the thing we replied to.
    for (const node of nodes) {
      if (!isOurs(node)) continue;
      if (!node.text || node.text.trim().length === 0) continue;
      const parentId = node.replied_to?.id;
      if (!parentId) continue;
      // Skip our reply to our own root post (that's a self-reply chain, not a Q&A).
      if (parentId === post.id) continue;
      const parent = byId.get(parentId);
      if (!parent) continue;
      // Don't pair our reply to another of our own messages.
      if (isOurs(parent)) continue;
      if (!parent.text || parent.text.trim().length === 0) continue;

      result.pairsFound++;

      try {
        await prisma.styleExample.create({
          data: {
            platform: "threads",
            questionText: parent.text,
            answerText: node.text,
            postContext: post.text ?? null,
            platformReplyId: node.id,
          },
        });
        result.inserted++;
      } catch (e) {
        // Unique constraint on platformReplyId means we already imported it.
        if ((e as Error).message.includes("Unique")) {
          result.duplicates++;
        } else {
          console.error("[learn-style] insert failed:", (e as Error).message);
        }
      }
    }
  }

  return result;
}
