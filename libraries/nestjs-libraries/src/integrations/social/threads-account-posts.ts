export type ThreadsCopyMedia = {
  id: string;
  path: string;
  alt?: string | null;
  thumbnail?: string | null;
  thumbnailTimestamp?: number | null;
};

export type ThreadsReusablePost = {
  id: string;
  text: string;
  username: string;
  timestamp: string | null;
  permalink: string | null;
  mediaType: string;
  mediaCount: number;
  mediaUnavailable: boolean;
};

export type ThreadsPostPage = {
  posts: ThreadsReusablePost[];
  nextCursor: string | null;
};

export type ThreadsGraphPost = {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  permalink?: string;
  media_type?: string;
  media_url?: string;
  children?: { data?: ThreadsGraphPost[]; paging?: { next?: string } };
};
