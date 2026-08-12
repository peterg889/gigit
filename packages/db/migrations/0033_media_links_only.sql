-- Media becomes link-only: EightGig stores no user media at all.
--
-- The product will not hold photos, audio or video on behalf of its users, so
-- every asset is now a URL on a third-party host we link to or embed (Flickr /
-- Imgur, SoundCloud / Bandcamp, YouTube / Vimeo). storage_key described a file
-- in our bucket and there is nothing left for it to point at; leaving the column
-- in place would be an open invitation for the next writer to put a key back in
-- it. `bytes` goes with it — it measured a file we no longer accept.
--
-- Both prod and staging hold zero media_assets rows, so every rewrite below is
-- a no-op today. They are written for a database that has rows anyway, because
-- a migration that quietly strands data is a worse bug than a slow one.

-- A row with no embed_url is a pointer to a file in our bucket. Once storage_key
-- is gone there is nothing that row can ever render: no URL to link to, no
-- thumbnail, no way for the owner to get it back except by re-adding the photo
-- on a host that keeps it. So it goes.
--
-- 0030 and 0032 refused to guess when they met data they could not migrate, and
-- that was right there: merging two accounts throws away bookings, reviews and
-- ledger history nobody can reconstruct. This is the opposite case. The row
-- carries no history — it is a pointer, the thing it points at stops being
-- served either way, and refusing would only leave every database on earth
-- stuck one migration behind for the sake of rows that already render nothing.
-- Prod and staging both hold zero media_assets rows; this fires only on a
-- developer's local database.
DO $migration$
DECLARE
  stranded integer;
BEGIN
  DELETE FROM media_assets WHERE embed_url IS NULL;
  GET DIAGNOSTICS stranded = ROW_COUNT;

  IF stranded > 0 THEN
    RAISE NOTICE
      '0033_media_links_only: dropped % media_assets row(s) that pointed at a stored file',
      stranded;
  END IF;
END
$migration$;

-- Kind vocabulary: image | audio | video_embed  ->  photo | audio | video.
-- `image` named the file format family we used to store, and `video_embed`
-- carried a suffix whose only job was to distinguish it from video we stored.
-- Now that every asset is an embed the suffix says nothing and the odd one out
-- is `image`. photo/audio/video are the oEmbed response types the providers
-- themselves return, so the column now agrees with the payload it came from.
update media_assets set kind = 'photo' where kind = 'image';
--> statement-breakpoint
update media_assets set kind = 'video' where kind = 'video_embed';
--> statement-breakpoint

-- Status vocabulary: uploaded | processing | ready | rejected -> held | ready | blocked.
--
-- 'uploaded' and 'processing' described bytes landing in a bucket and then being
-- sniffed, re-encoded and stripped of EXIF. None of that happens to a link. What
-- does still happen is a moderation read of the title and provider, and it has
-- exactly three outcomes: show it, hold it for a human, refuse it.
--
-- 'ready' deliberately keeps its name. Every public profile page filters on
-- status = 'ready' (apps/web/src/app/{p,v,t}/[id]/page.tsx); renaming the one
-- visible state to something prettier would have blanked every EPK on the site
-- the moment this migration ran, for no gain.
update media_assets set status = 'held' where status in ('uploaded', 'processing');
--> statement-breakpoint
update media_assets set status = 'blocked' where status = 'rejected';
--> statement-breakpoint

-- Nothing is public until a screen says so. The old default named a step
-- ('uploaded') that no longer exists, and defaulting a link to visible would
-- make a missed status write publish unscreened content instead of hiding it.
alter table media_assets alter column status set default 'held';
--> statement-breakpoint

alter table media_assets drop column if exists storage_key;
--> statement-breakpoint
alter table media_assets drop column if exists bytes;
--> statement-breakpoint

-- A media asset with no link is not a media asset any more.
alter table media_assets alter column embed_url set not null;
--> statement-breakpoint

-- These two vocabularies are read by page filters that fail silently: a row
-- written with a retired value ('image', 'video_embed', 'processing') does not
-- error, it just never appears on the profile — a photo the act can see in
-- their own manager and a venue cannot see at all. Constrain them so a writer
-- that missed this rename fails loudly at the insert instead.
alter table media_assets
  add constraint media_assets_kind_check check (kind in ('photo', 'audio', 'video'));
--> statement-breakpoint
alter table media_assets
  add constraint media_assets_status_check check (status in ('held', 'ready', 'blocked'));
--> statement-breakpoint

comment on column media_assets.kind is
  'photo | audio | video — the oEmbed type of the linked resource. EightGig stores no media.';
--> statement-breakpoint
comment on column media_assets.status is
  'held (awaiting screen or moderator) | ready (public) | blocked (refused).';
