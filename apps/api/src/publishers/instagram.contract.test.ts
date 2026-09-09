import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpResponse } from "msw";
import { metaServer } from "./meta-stub.js";
import {
  InstagramApiError,
  fetchAccountSnapshot,
  fetchPostInsights,
  listMyMedia,
  publishCarousel,
  publishImage,
  publishReel,
  publishStory,
} from "./instagram.js";

const { stub, server } = metaServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  stub.reset();
});
afterAll(() => server.close());

const USER = "17841400000000000";
const TOKEN = "IG_TOKEN";

describe("publishImage", () => {
  it("creates a container, polls status_code, then publishes", async () => {
    const out = await publishImage(USER, TOKEN, {
      imageUrl: "https://x.test/a.jpg",
      caption: "hostel lights off",
    });

    expect(stub.paths()).toEqual([
      `POST /${USER}/media`,
      `GET /id_1`,
      `POST /${USER}/media_publish`,
    ]);
    expect(stub.params(0)).toMatchObject({
      image_url: "https://x.test/a.jpg",
      caption: "hostel lights off",
      access_token: TOKEN,
    });
    // IG's status field is status_code, not Threads' status.
    expect(stub.params(1).fields).toBe("status_code");
    expect(stub.params(2).creation_id).toBe("id_1");
    expect(out.id).toBe("id_3");
  });

  it("omits caption when absent", async () => {
    await publishImage(USER, TOKEN, { imageUrl: "https://x.test/a.jpg" });
    expect(stub.params(0)).not.toHaveProperty("caption");
  });
});

describe("publishReel", () => {
  it("sends REELS with share_to_feed defaulting to true", async () => {
    await publishReel(USER, TOKEN, { videoUrl: "https://x.test/a.mp4", caption: "reel" });
    expect(stub.params(0)).toMatchObject({
      media_type: "REELS",
      video_url: "https://x.test/a.mp4",
      share_to_feed: "true",
      caption: "reel",
    });
  });

  it("honours share_to_feed=false", async () => {
    await publishReel(USER, TOKEN, { videoUrl: "https://x.test/a.mp4", shareToFeed: false });
    expect(stub.params(0).share_to_feed).toBe("false");
  });

  it("sends thumb_offset and cover_url when given", async () => {
    await publishReel(USER, TOKEN, {
      videoUrl: "https://x.test/a.mp4",
      thumbOffsetMs: 2500,
      coverUrl: "https://x.test/cover.jpg",
    });
    expect(stub.params(0)).toMatchObject({
      thumb_offset: "2500",
      cover_url: "https://x.test/cover.jpg",
    });
  });

  // 0 is a legitimate cover offset (first frame) and must not be dropped by a
  // falsy check.
  it("sends thumb_offset=0 rather than omitting it", async () => {
    await publishReel(USER, TOKEN, { videoUrl: "https://x.test/a.mp4", thumbOffsetMs: 0 });
    expect(stub.params(0).thumb_offset).toBe("0");
  });
});

describe("publishStory", () => {
  it("sends STORIES with image_url for an image", async () => {
    await publishStory(USER, TOKEN, {
      mediaUrl: "https://x.test/a.jpg",
      mediaType: "image",
    });
    expect(stub.params(0)).toMatchObject({
      media_type: "STORIES",
      image_url: "https://x.test/a.jpg",
    });
    expect(stub.params(0)).not.toHaveProperty("video_url");
  });

  it("sends video_url for a video", async () => {
    await publishStory(USER, TOKEN, {
      mediaUrl: "https://x.test/a.mp4",
      mediaType: "video",
    });
    expect(stub.params(0)).toMatchObject({ video_url: "https://x.test/a.mp4" });
    expect(stub.params(0)).not.toHaveProperty("image_url");
  });

  // Stories reject a caption at the API; sending one is a guaranteed failure.
  it("never sends a caption", async () => {
    await publishStory(USER, TOKEN, { mediaUrl: "https://x.test/a.jpg", mediaType: "image" });
    expect(stub.params(0)).not.toHaveProperty("caption");
  });
});

describe("publishCarousel", () => {
  const img = (n: number) => ({ url: `https://x.test/${n}.jpg`, type: "image" as const });

  it("creates children, then the parent, then publishes", async () => {
    await publishCarousel(USER, TOKEN, {
      items: [img(1), img(2)],
      caption: "three ways",
    });

    // Image children are not polled — only the parent container is.
    expect(stub.paths()).toEqual([
      `POST /${USER}/media`,
      `POST /${USER}/media`,
      `POST /${USER}/media`,
      `GET /id_3`,
      `POST /${USER}/media_publish`,
    ]);
    expect(stub.params(0)).toMatchObject({
      is_carousel_item: "true",
      image_url: "https://x.test/1.jpg",
    });
    expect(stub.params(2)).toMatchObject({
      media_type: "CAROUSEL",
      children: "id_1,id_2",
      caption: "three ways",
    });
    expect(stub.params(2)).not.toHaveProperty("is_carousel_item");
  });

  it("polls a video child before referencing it", async () => {
    await publishCarousel(USER, TOKEN, {
      items: [{ url: "https://x.test/a.mp4", type: "video" }, img(2)],
    });
    expect(stub.params(0)).toMatchObject({
      media_type: "VIDEO",
      video_url: "https://x.test/a.mp4",
    });
    expect(stub.paths()[1]).toBe("GET /id_1");
  });

  it.each([1, 11])("rejects %i items before calling the API", async (n) => {
    await expect(
      publishCarousel(USER, TOKEN, { items: Array.from({ length: n }, (_, i) => img(i)) })
    ).rejects.toThrow(/2-10 items/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("container extras", () => {
  it("JSON-encodes user tags", async () => {
    await publishImage(USER, TOKEN, {
      imageUrl: "https://x.test/a.jpg",
      userTags: [{ username: "friend", x: 0.4, y: 0.6 }],
    });
    expect(JSON.parse(stub.params(0).user_tags!)).toEqual([
      { username: "friend", x: 0.4, y: 0.6 },
    ]);
  });

  it("sends location_id and strips @ from collaborators", async () => {
    await publishImage(USER, TOKEN, {
      imageUrl: "https://x.test/a.jpg",
      extras: { locationId: "123456", collaborators: ["@one", "two"] },
    });
    expect(stub.params(0).location_id).toBe("123456");
    expect(JSON.parse(stub.params(0).collaborators!)).toEqual(["one", "two"]);
  });

  it("dedupes collaborators that differ only by the @ prefix", async () => {
    await publishImage(USER, TOKEN, {
      imageUrl: "https://x.test/a.jpg",
      extras: { collaborators: ["@dup", "dup", "other"] },
    });
    expect(JSON.parse(stub.params(0).collaborators!)).toEqual(["dup", "other"]);
  });

  it("omits extras entirely when empty", async () => {
    await publishImage(USER, TOKEN, {
      imageUrl: "https://x.test/a.jpg",
      extras: { collaborators: [] },
    });
    const p = stub.params(0);
    expect(p).not.toHaveProperty("collaborators");
    expect(p).not.toHaveProperty("location_id");
    expect(p).not.toHaveProperty("user_tags");
  });

  // location_id and collaborators are invalid on a carousel child and cause the
  // child create to fail; they belong on the parent only.
  it("keeps location and collaborators off carousel children", async () => {
    await publishCarousel(USER, TOKEN, {
      items: [
        { url: "https://x.test/1.jpg", type: "image", altText: "one" },
        { url: "https://x.test/2.jpg", type: "image" },
      ],
      extras: { locationId: "123456", collaborators: ["@one"] },
    });
    expect(stub.params(0).alt_text).toBe("one");
    expect(stub.params(0)).not.toHaveProperty("location_id");
    expect(stub.params(0)).not.toHaveProperty("collaborators");
    expect(stub.params(2).location_id).toBe("123456");
  });
});

describe("container status handling", () => {
  it("throws without publishing when the container errors", async () => {
    stub.on((call) =>
      call.method === "GET" && call.params.fields === "status_code"
        ? { status_code: "ERROR" }
        : undefined
    );
    await expect(
      publishImage(USER, TOKEN, { imageUrl: "https://x.test/a.jpg" })
    ).rejects.toThrow(/ended in ERROR/);
    expect(stub.count("/media_publish")).toBe(0);
  });
});

describe("error parsing", () => {
  it("surfaces status and parsed body", async () => {
    const body = {
      error: {
        message: "The image is not a valid format",
        code: 9004,
        type: "OAuthException",
      },
    };
    stub.failOn("/media", 400, body);

    const err = await publishImage(USER, TOKEN, {
      imageUrl: "https://x.test/a.png",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InstagramApiError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual(body);
  });
});

describe("read endpoints", () => {
  it("maps an account snapshot, defaulting followers to 0", async () => {
    stub.on(() => ({ followers_count: 4210, follows_count: 300, media_count: 88 }));
    expect(await fetchAccountSnapshot(USER, TOKEN)).toEqual({
      followers: 4210,
      following: 300,
      postsCount: 88,
    });

    stub.reset();
    stub.on(() => ({}));
    expect((await fetchAccountSnapshot(USER, TOKEN)).followers).toBe(0);
  });

  it("skips metrics the post type does not support", async () => {
    stub.on((call) => {
      const metric = call.params.metric;
      if (metric === "saves" || metric === "follows") {
        // A real per-metric rejection, so this exercises the try/catch rather
        // than just returning a body with nothing to parse.
        return HttpResponse.json(
          { error: { message: `metric ${metric} not supported`, code: 100 } },
          { status: 400 }
        );
      }
      return { data: [{ name: metric, values: [{ value: 7 }] }] };
    });
    const insights = await fetchPostInsights("media_1", TOKEN);
    expect(insights.reach).toBe(7);
    expect(insights.likes).toBe(7);
    expect(insights.saves).toBeUndefined();
    expect(insights.follows).toBeUndefined();
  });

  it("stops paginating once a post older than sinceMs appears", async () => {
    const since = Date.parse("2026-06-01T00:00:00.000Z");
    stub.on(() => ({
      data: [
        { id: "m1", media_type: "IMAGE", timestamp: "2026-06-10T00:00:00+0000" },
        { id: "m2", media_type: "IMAGE", timestamp: "2026-05-01T00:00:00+0000" },
      ],
      paging: { next: "https://next", cursors: { after: "CURSOR" } },
    }));

    const media = await listMyMedia(USER, TOKEN, { sinceMs: since });
    expect(media.map((m) => m.id)).toEqual(["m1"]);
    expect(stub.count("/media")).toBe(1);
  });

  it("follows the cursor while every post is recent enough", async () => {
    let page = 0;
    stub.on(() => {
      page++;
      return {
        data: [{ id: `m${page}`, media_type: "IMAGE", timestamp: "2026-06-10T00:00:00+0000" }],
        paging:
          page < 3 ? { next: "https://next", cursors: { after: `CUR${page}` } } : {},
      };
    });
    const media = await listMyMedia(USER, TOKEN, { maxPages: 8 });
    expect(media.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(stub.calls[1]!.params.after).toBe("CUR1");
  });

  it("drops items with no id or timestamp", async () => {
    stub.on(() => ({ data: [{ id: "ok", timestamp: "2026-06-10T00:00:00+0000" }, { id: "no-ts" }] }));
    const media = await listMyMedia(USER, TOKEN);
    expect(media.map((m) => m.id)).toEqual(["ok"]);
  });
});
