import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CDN_BASE = "https://ltd-alethea-nbhi763-bc60a88e.koyeb.app";
const BUCKET = "manga-images";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/**
 * Upload a file to NapaExtra CDN via Supabase Storage as intermediary.
 * 1. Upload to Supabase Storage (temp) → get public URL
 * 2. ensurePath on NapaExtra → get folder path
 * 3. startFileDownloadFromUrl → get NapaExtra file_id
 * 4. Return full CDN URL
 */
async function uploadToNapaExtra(
  supabase: ReturnType<typeof getSupabase>,
  file: File,
  folderPath: string[],
  filename: string,
  password: string
): Promise<string> {
  const tempPath = `temp/${crypto.randomUUID()}_${filename}`;
  const fileBuffer = await file.arrayBuffer();

  // 1. Upload to Supabase Storage temporarily
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(tempPath, fileBuffer, {
      contentType: file.type || "image/jpeg",
      upsert: true,
    });
  if (uploadError) throw new Error(`Temp upload failed: ${uploadError.message}`);

  // 2. Get public URL
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(tempPath);
  const publicUrl = urlData.publicUrl;

  try {
    // 3. Create folder structure on NapaExtra
    const ensureRes = await fetch(`${CDN_BASE}/api/ensurePath`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, folder_hierarchy: folderPath }),
    });
    const ensureData = await ensureRes.json();
    if (ensureData.status !== "ok") {
      throw new Error(`ensurePath failed: ${JSON.stringify(ensureData)}`);
    }

    // 4. Tell NapaExtra to download from our public URL
    const dlRes = await fetch(`${CDN_BASE}/api/startFileDownloadFromUrl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: publicUrl,
        path: ensureData.final_upload_path,
        filename,
        password,
      }),
    });
    const dlData = await dlRes.json();
    if (dlData.status !== "ok") {
      throw new Error(`NapaExtra upload failed: ${JSON.stringify(dlData)}`);
    }

    // 5. Return full CDN URL (dlData.id is the NapaExtra file_id)
    return `${CDN_BASE}/view/${dlData.id}`;
  } finally {
    // 6. Clean up temp file from storage (fire and forget)
    supabase.storage.from(BUCKET).remove([tempPath]).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const NAPAEXTRA_PASSWORD = Deno.env.get("NAPAEXTRA_PASSWORD");
    if (!NAPAEXTRA_PASSWORD) throw new Error("NAPAEXTRA_PASSWORD not configured");

    const authHeader = req.headers.get("authorization");
    if (!authHeader) throw new Error("No authorization header");

    const supabase = getSupabase();
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    );

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authError,
    } = await anonClient.auth.getUser(token);
    if (authError || !user) throw new Error("Unauthorized");

    const { data: hasPublisher } = await supabase.rpc("has_role", {
      _user_id: user.id,
      _role: "publisher",
    });
    if (!hasPublisher) throw new Error("Only publishers can upload");

    const formData = await req.formData();
    const uploadType = (formData.get("type") as string) || "chapter";
    const mangaId = formData.get("manga_id") as string;

    if (uploadType === "cover") {
      // ─── Cover Image Upload ──────────────────────────────────
      const coverFile = formData.get("cover") as File;
      if (!mangaId || !coverFile) throw new Error("manga_id and cover file required");

      const { data: manga } = await supabase
        .from("manga")
        .select("id, creator_id, title")
        .eq("id", mangaId)
        .single();
      if (!manga || manga.creator_id !== user.id) throw new Error("Not your manga");

      const ext = coverFile.name.split(".").pop() || "jpg";
      const cdnUrl = await uploadToNapaExtra(
        supabase,
        coverFile,
        [manga.title, "covers"],
        `cover.${ext}`,
        NAPAEXTRA_PASSWORD
      );

      // Save full CDN URL in cover_url
      await supabase.from("manga").update({ cover_url: cdnUrl }).eq("id", mangaId);

      return new Response(
        JSON.stringify({ success: true, cover_file_id: cdnUrl }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Chapter Pages Upload ────────────────────────────────
    const chapterId = formData.get("chapter_id") as string;
    const files = formData.getAll("pages") as File[];

    if (!mangaId || !chapterId || files.length === 0) {
      throw new Error("manga_id, chapter_id, and pages are required");
    }

    const { data: manga, error: mangaError } = await supabase
      .from("manga")
      .select("id, creator_id, title")
      .eq("id", mangaId)
      .single();
    if (mangaError || !manga) throw new Error("Manga not found");
    if (manga.creator_id !== user.id) throw new Error("Not your manga");

    const { data: chapter } = await supabase
      .from("chapters")
      .select("chapter_number")
      .eq("id", chapterId)
      .single();
    const chapterFolder = `Chapter_${chapter?.chapter_number || chapterId.slice(0, 8)}`;

    const uploadedPages: {
      chapter_id: string;
      page_number: number;
      telegram_file_id: string;
      file_size: number;
    }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split(".").pop() || "jpg";
      const filename = `page_${String(i + 1).padStart(3, "0")}.${ext}`;

      const cdnUrl = await uploadToNapaExtra(
        supabase,
        file,
        [manga.title, chapterFolder],
        filename,
        NAPAEXTRA_PASSWORD
      );

      uploadedPages.push({
        chapter_id: chapterId,
        page_number: i + 1,
        telegram_file_id: cdnUrl, // Full CDN URL stored in telegram_file_id column
        file_size: file.size,
      });
    }

    const { error: insertError } = await supabase.from("chapter_pages").insert(uploadedPages);
    if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

    return new Response(
      JSON.stringify({
        success: true,
        pages_uploaded: uploadedPages.length,
        manga_short_id: mangaId.slice(0, 8).toUpperCase(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("upload error:", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
