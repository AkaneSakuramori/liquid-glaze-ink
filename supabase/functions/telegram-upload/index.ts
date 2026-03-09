import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const CDN_BASE = Deno.env.get("NAPAEXTRA_URL") || "";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

/**
 * Upload a single file to NapaExtra CDN using /api/upload (direct multipart).
 * 1. ensurePath → get folder
 * 2. /api/upload → direct multipart upload
 * 3. Return CDN view URL
 */
async function uploadToNapaExtra(
  file: File,
  folderPath: string[],
  filename: string,
  password: string
): Promise<string> {
  // 1. Create folder structure
  const ensureRes = await fetch(`${CDN_BASE}/api/ensurePath`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, folder_hierarchy: folderPath }),
  });
  const ensureData = await ensureRes.json();
  if (ensureData.status !== "ok") {
    throw new Error(`ensurePath failed: ${JSON.stringify(ensureData)}`);
  }

  // 2. Direct multipart upload to /api/upload
  const uploadForm = new FormData();
  uploadForm.append("file", file, filename);
  uploadForm.append("path", ensureData.final_upload_path);
  uploadForm.append("password", password);
  uploadForm.append("id", `upload_${Date.now()}`);
  uploadForm.append("total_size", String(file.size));

  const uploadRes = await fetch(`${CDN_BASE}/api/upload`, {
    method: "POST",
    body: uploadForm,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.status !== "ok") {
    throw new Error(`Upload failed: ${JSON.stringify(uploadData)}`);
  }

  // 3. Return the file ID (NOT full URL — store only the ID per API best practice)
  return uploadData.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const NAPAEXTRA_PASSWORD = Deno.env.get("NAPAEXTRA_PASSWORD");
    if (!NAPAEXTRA_PASSWORD) throw new Error("NAPAEXTRA_PASSWORD not configured");
    if (!CDN_BASE) throw new Error("NAPAEXTRA_URL not configured");

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
      const fileId = await uploadToNapaExtra(
        coverFile,
        [manga.title, "covers"],
        `cover.${ext}`,
        NAPAEXTRA_PASSWORD
      );

      // Store the full CDN URL for covers
      const cdnUrl = `${CDN_BASE}/view/${fileId}`;
      await supabase.from("manga").update({ cover_url: cdnUrl }).eq("id", mangaId);

      return new Response(
        JSON.stringify({ success: true, cover_file_id: cdnUrl }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Single Page Upload (for progress tracking) ─────────
    if (uploadType === "single_page") {
      const chapterId = formData.get("chapter_id") as string;
      const pageFile = formData.get("page") as File;
      const pageNumber = parseInt(formData.get("page_number") as string);

      if (!mangaId || !chapterId || !pageFile || !pageNumber) {
        throw new Error("manga_id, chapter_id, page, and page_number required");
      }

      const { data: manga } = await supabase
        .from("manga")
        .select("id, creator_id, title")
        .eq("id", mangaId)
        .single();
      if (!manga || manga.creator_id !== user.id) throw new Error("Not your manga");

      const { data: chapter } = await supabase
        .from("chapters")
        .select("chapter_number")
        .eq("id", chapterId)
        .single();
      const chapterFolder = `Chapter_${chapter?.chapter_number || chapterId.slice(0, 8)}`;

      const ext = pageFile.name.split(".").pop() || "jpg";
      const filename = `page_${String(pageNumber).padStart(3, "0")}.${ext}`;

      const fileId = await uploadToNapaExtra(
        pageFile,
        [manga.title, chapterFolder],
        filename,
        NAPAEXTRA_PASSWORD
      );

      // Store the file ID (not full URL) for pages
      const cdnUrl = `${CDN_BASE}/view/${fileId}`;

      const { error: insertError } = await supabase.from("chapter_pages").insert({
        chapter_id: chapterId,
        page_number: pageNumber,
        telegram_file_id: cdnUrl,
        file_size: pageFile.size,
      });
      if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

      return new Response(
        JSON.stringify({ success: true, page_number: pageNumber, file_id: fileId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Batch Chapter Pages Upload (legacy) ────────────────
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

      const fileId = await uploadToNapaExtra(
        file,
        [manga.title, chapterFolder],
        filename,
        NAPAEXTRA_PASSWORD
      );

      const cdnUrl = `${CDN_BASE}/view/${fileId}`;
      uploadedPages.push({
        chapter_id: chapterId,
        page_number: i + 1,
        telegram_file_id: cdnUrl,
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
