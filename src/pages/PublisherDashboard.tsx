import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Upload, BarChart3, Settings, Trash2, Edit, Plus, Image, FileText, ChevronRight, Loader2, X, Clock, CalendarIcon, DollarSign } from 'lucide-react';
import { toast } from 'sonner';
import CreatorAnalytics from '@/components/CreatorAnalytics';
import CreatorEarnings from '@/components/CreatorEarnings';
import { Progress } from '@/components/ui/progress';

const allGenres = [
  'Action', 'Fantasy', 'Romance', 'Sci-Fi', 'Thriller', 'Drama',
  'Mystery', 'Horror', 'Slice of Life', 'Adventure', 'Historical', 'School',
];

const slugify = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PublisherDashboard: React.FC = () => {
  const { user, profile } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('works');

  // Upload manga state
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadDesc, setUploadDesc] = useState('');
  const [uploadGenres, setUploadGenres] = useState<string[]>([]);
  const [uploadStatus, setUploadStatus] = useState('ONGOING');
  const [copyrightChecked, setCopyrightChecked] = useState(false);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Chapter 1 files for initial submission
  const [ch1Files, setCh1Files] = useState<File[]>([]);
  const [ch1Title, setCh1Title] = useState('');
  const ch1InputRef = useRef<HTMLInputElement>(null);

  // Chapter upload state
  const [selectedMangaId, setSelectedMangaId] = useState<string | null>(null);
  const [chapterNumber, setChapterNumber] = useState(1);
  const [chapterTitle, setChapterTitle] = useState('');
  const [pageFiles, setPageFiles] = useState<File[]>([]);
  const [uploadingChapter, setUploadingChapter] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const pageInputRef = useRef<HTMLInputElement>(null);

  // Fetch creator's manga
  const { data: myManga, isLoading: loadingManga } = useQuery({
    queryKey: ['creator-manga', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('manga')
        .select('*')
        .eq('creator_id', user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });

  // Fetch chapters for selected manga
  const { data: chapters } = useQuery({
    queryKey: ['creator-chapters', selectedMangaId],
    queryFn: async () => {
      if (!selectedMangaId) return [];
      const { data, error } = await supabase
        .from('chapters')
        .select('*, chapter_pages(count)')
        .eq('manga_id', selectedMangaId)
        .order('chapter_number', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!selectedMangaId,
  });

  // Fetch total chapters across all manga for analytics
  const { data: allChaptersCount } = useQuery({
    queryKey: ['creator-all-chapters', user?.id],
    queryFn: async () => {
      if (!user || !myManga || myManga.length === 0) return 0;
      const mangaIds = myManga.map(m => m.id);
      const { count, error } = await supabase
        .from('chapters')
        .select('id', { count: 'exact', head: true })
        .in('manga_id', mangaIds);
      if (error) return 0;
      return count || 0;
    },
    enabled: !!user && !!myManga && myManga.length > 0,
  });

  // Auto-set chapter number when selecting a manga
  useEffect(() => {
    if (chapters && chapters.length > 0) {
      const maxChapter = Math.max(...chapters.map(c => c.chapter_number));
      setChapterNumber(maxChapter + 1);
    } else if (selectedMangaId) {
      setChapterNumber(1);
    }
  }, [chapters, selectedMangaId]);

  // Stats
  const totalManga = myManga?.length || 0;
  const totalChapters = allChaptersCount || 0;

  const tabs = [
    { id: 'works', label: 'My Works', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'create', label: 'New Manhwa', icon: <Plus className="w-4 h-4" /> },
    { id: 'chapters', label: 'Chapters', icon: <FileText className="w-4 h-4" /> },
    { id: 'earnings', label: 'Earnings', icon: <DollarSign className="w-4 h-4" /> },
    { id: 'analytics', label: 'Analytics', icon: <BarChart3 className="w-4 h-4" /> },
  ];

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCoverFile(file);
      setCoverPreview(URL.createObjectURL(file));
    }
  };

  const uploadSinglePage = async (
    token: string,
    mangaId: string,
    chapterId: string,
    file: File,
    pageNumber: number
  ) => {
    const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
    const formData = new FormData();
    formData.append('type', 'single_page');
    formData.append('manga_id', mangaId);
    formData.append('chapter_id', chapterId);
    formData.append('page', file);
    formData.append('page_number', String(pageNumber));

    const res = await fetch(`https://${projectId}.supabase.co/functions/v1/telegram-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.error || `Page ${pageNumber} upload failed`);
    return result;
  };

  const handleCreateManga = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !uploadTitle || !copyrightChecked) return;
    if (ch1Files.length === 0) {
      toast.error('Chapter 1 is required! Upload at least one page.');
      return;
    }

    setSubmitting(true);
    setUploadProgress(0);
    try {
      const slug = slugify(uploadTitle) + '-' + Date.now().toString(36);
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;

      // 1. Create manga record
      const { data: manga, error } = await supabase
        .from('manga')
        .insert({
          creator_id: user.id,
          title: uploadTitle,
          slug,
          description: uploadDesc,
          genres: uploadGenres,
          status: uploadStatus,
          approval_status: 'PENDING',
        })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') toast.error('A manhwa with this title already exists');
        else toast.error(error.message);
        return;
      }

      const totalFiles = ch1Files.length + (coverFile ? 1 : 0);
      let uploaded = 0;

      // 2. Upload cover if provided
      if (coverFile) {
        const coverForm = new FormData();
        coverForm.append('type', 'cover');
        coverForm.append('manga_id', manga.id);
        coverForm.append('cover', coverFile);
        const coverRes = await fetch(`https://${projectId}.supabase.co/functions/v1/telegram-upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: coverForm,
        });
        const coverResult = await coverRes.json();
        if (!coverResult.success) console.error('Cover upload failed:', coverResult.error);
        uploaded++;
        setUploadProgress(Math.round((uploaded / totalFiles) * 100));
      }

      // 3. Create chapter 1
      const { data: chapter, error: chapterError } = await supabase
        .from('chapters')
        .insert({ manga_id: manga.id, chapter_number: 1, title: ch1Title || null })
        .select()
        .single();

      if (chapterError) {
        toast.error('Failed to create chapter 1: ' + chapterError.message);
        return;
      }

      // 4. Upload pages one-by-one with progress
      for (let i = 0; i < ch1Files.length; i++) {
        await uploadSinglePage(token, manga.id, chapter.id, ch1Files[i], i + 1);
        uploaded++;
        setUploadProgress(Math.round((uploaded / totalFiles) * 100));
      }

      toast.success(`🎉 Manhwa submitted with Chapter 1 (${ch1Files.length} pages)! Admin will review within 48 hours.`);
      setUploadTitle(''); setUploadDesc(''); setUploadGenres([]); setCopyrightChecked(false);
      setCoverFile(null); setCoverPreview(null); setCh1Files([]); setCh1Title('');
      queryClient.invalidateQueries({ queryKey: ['creator-manga'] });
      setActiveTab('works');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create manhwa');
    } finally {
      setSubmitting(false);
      setUploadProgress(0);
    }
  };

  const handlePageFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    // Sort files by name to maintain order
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setPageFiles(prev => [...prev, ...files]);
  };

  const removePageFile = (index: number) => {
    setPageFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleUploadChapter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !selectedMangaId || pageFiles.length === 0) return;

    setUploadingChapter(true);
    setUploadProgress(0);

    try {
      // Create chapter record first
      const scheduledAt = scheduleEnabled && scheduledDate && scheduledTime
        ? new Date(`${scheduledDate}T${scheduledTime}`).toISOString()
        : null;

      const { data: chapter, error: chapterError } = await supabase
        .from('chapters')
        .insert({
          manga_id: selectedMangaId,
          chapter_number: chapterNumber,
          title: chapterTitle || null,
          is_published: !scheduledAt,
          scheduled_at: scheduledAt,
        } as any)
        .select()
        .single();

      if (chapterError) {
        if (chapterError.code === '23505') {
          toast.error(`Chapter ${chapterNumber} already exists`);
        } else {
          toast.error(chapterError.message);
        }
        return;
      }

      // Upload pages to Telegram via edge function
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const formData = new FormData();
      formData.append('manga_id', selectedMangaId);
      formData.append('chapter_id', chapter.id);
      pageFiles.forEach((file) => {
        formData.append('pages', file);
      });

      const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID;
      const res = await fetch(
        `https://${projectId}.supabase.co/functions/v1/telegram-upload`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        }
      );

      const result = await res.json();
      if (!result.success) {
        // Clean up chapter if upload failed
        await supabase.from('chapters').delete().eq('id', chapter.id);
        throw new Error(result.error || 'Upload failed');
      }

      const schedLabel = scheduledAt ? ` (scheduled for ${new Date(scheduledAt).toLocaleString()})` : '';
      toast.success(`Chapter ${chapterNumber} uploaded!${schedLabel} (${result.pages_uploaded} pages) — Admin will review before publishing.`);
      setPageFiles([]);
      setChapterTitle('');
      setChapterNumber(prev => prev + 1);
      setScheduleEnabled(false);
      setScheduledDate('');
      setScheduledTime('');
      queryClient.invalidateQueries({ queryKey: ['creator-chapters'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to upload chapter');
    } finally {
      setUploadingChapter(false);
      setUploadProgress(0);
    }
  };

  const deleteManga = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('manga').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Manhwa deleted');
      queryClient.invalidateQueries({ queryKey: ['creator-manga'] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const toggleGenre = (g: string) => {
    setUploadGenres(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      PENDING: 'border-yellow-500/50 bg-yellow-500/10 text-yellow-600',
      APPROVED: 'border-green-500/50 bg-green-500/10 text-green-600',
      REJECTED: 'border-destructive/50 bg-destructive/10 text-destructive',
    };
    return colors[status] || 'border-foreground/30';
  };

  return (
    <div className="min-h-screen pt-24 pb-12 bg-background">
      <div className="max-w-7xl mx-auto px-4 flex flex-col lg:flex-row gap-6">
        {/* Sidebar */}
        <aside className="lg:w-56 flex-shrink-0">
          <div className="brutal-card p-4 space-y-1 sticky top-24">
            <div className="flex items-center gap-3 mb-4 pb-4 border-b-2 border-foreground">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold border border-foreground overflow-hidden">
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt={`${profile.display_name || 'Creator'}'s avatar`} className="w-full h-full object-cover" />
                ) : (
                  profile?.display_name?.[0]?.toUpperCase() || 'C'
                )}
              </div>
              <div>
                <p className="text-sm font-bold truncate">{profile?.display_name || 'Creator'}</p>
                <p className="text-[10px] text-primary uppercase tracking-wider font-bold">Creator Studio</p>
              </div>
            </div>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors font-medium ${activeTab === t.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          {/* MY WORKS TAB */}
          {activeTab === 'works' && (
            <div>
              <h2 className="text-display text-3xl mb-4 tracking-wider">MY WORKS</h2>
              {loadingManga ? (
                <div className="brutal-card p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></div>
              ) : (
                <div className="brutal-card overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b-2 border-foreground text-left text-muted-foreground text-xs uppercase tracking-wider">
                          <th className="px-4 py-3">Title</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Approval</th>
                          <th className="px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(myManga || []).map(m => (
                          <tr key={m.id} className="border-b border-foreground/10 hover:bg-primary/5 transition-colors">
                            <td className="px-4 py-3 font-semibold">{m.title}</td>
                            <td className="px-4 py-3"><span className="px-2 py-0.5 text-xs font-bold border border-foreground/30">{m.status}</span></td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 text-xs font-bold border ${statusBadge(m.approval_status)}`}>
                                {m.approval_status}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex gap-1">
                                <button onClick={() => { setSelectedMangaId(m.id); setActiveTab('chapters'); }} className="p-1.5 hover:text-primary transition-colors" title="Manage chapters">
                                  <FileText className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => { if (confirm('Delete this manhwa?')) deleteManga.mutate(m.id); }} className="p-1.5 hover:text-destructive transition-colors" title="Delete">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {(!myManga || myManga.length === 0) && (
                          <tr>
                            <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                              No works yet.{' '}
                              <button onClick={() => setActiveTab('create')} className="text-primary font-semibold hover:underline">
                                Create your first manhwa!
                              </button>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* CREATE MANHWA TAB */}
          {activeTab === 'create' && (
            <div>
              <h2 className="text-display text-3xl mb-4 tracking-wider">NEW MANHWA</h2>
              <form onSubmit={handleCreateManga} className="brutal-card p-6 space-y-5">
                <div>
                  <label className="text-sm font-semibold block mb-2">Cover Image</label>
                  <label className="border-2 border-dashed border-foreground p-6 text-center hover:border-primary transition-colors cursor-pointer block">
                    {coverPreview ? (
                      <img src={coverPreview} alt="Cover preview" className="w-24 h-36 object-cover mx-auto border border-foreground/20" />
                    ) : (
                      <>
                        <Image className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Click to upload cover</p>
                      </>
                    )}
                    <input type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />
                  </label>
                </div>

                <div>
                  <label className="text-sm font-semibold block mb-1.5">Title *</label>
                  <input value={uploadTitle} onChange={e => setUploadTitle(e.target.value)} className="w-full px-3 py-2.5 bg-background border-2 border-foreground text-sm focus:outline-none focus:border-primary transition-colors" required />
                </div>

                <div>
                  <label className="text-sm font-semibold block mb-1.5">Description</label>
                  <textarea value={uploadDesc} onChange={e => setUploadDesc(e.target.value)} rows={4} className="w-full px-3 py-2.5 bg-background border-2 border-foreground text-sm focus:outline-none focus:border-primary transition-colors resize-none" />
                </div>

                <div>
                  <label className="text-sm font-semibold block mb-1.5">Status</label>
                  <select value={uploadStatus} onChange={e => setUploadStatus(e.target.value)} className="px-3 py-2.5 bg-background border-2 border-foreground text-sm focus:outline-none focus:border-primary">
                    <option value="ONGOING">Ongoing</option>
                    <option value="COMPLETED">Completed</option>
                    <option value="HIATUS">Hiatus</option>
                  </select>
                </div>

                <div>
                  <label className="text-sm font-semibold block mb-2">Genres</label>
                  <div className="flex flex-wrap gap-1.5">
                    {allGenres.map(g => (
                      <button key={g} type="button" onClick={() => toggleGenre(g)} className={`px-2.5 py-1 text-xs border transition-all font-medium ${uploadGenres.includes(g) ? 'border-primary bg-primary/10 text-primary' : 'border-foreground/20 hover:border-foreground'}`}>{g}</button>
                    ))}
                  </div>
                </div>

                {/* Chapter 1 Upload - Required */}
                <div className="border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
                  <label className="text-sm font-semibold block">Chapter 1 Pages * <span className="text-xs text-muted-foreground font-normal">(Required for submission)</span></label>
                  <div>
                    <label className="text-sm font-semibold block mb-1.5">Chapter 1 Title (optional)</label>
                    <input value={ch1Title} onChange={e => setCh1Title(e.target.value)} className="w-full px-3 py-2.5 bg-background border-2 border-foreground text-sm focus:outline-none focus:border-primary transition-colors" placeholder="e.g. The Beginning" />
                  </div>
                  <div
                    className="border-2 border-dashed border-foreground p-4 text-center hover:border-primary transition-colors cursor-pointer"
                    onClick={() => ch1InputRef.current?.click()}
                  >
                    <Upload className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Click to add Chapter 1 pages ({ch1Files.length} selected)</p>
                  </div>
                  <input ref={ch1InputRef} type="file" accept="image/*" multiple onChange={e => {
                    const files = Array.from(e.target.files || []);
                    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                    setCh1Files(prev => [...prev, ...files]);
                  }} className="hidden" />
                  {ch1Files.length > 0 && (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {ch1Files.map((f, i) => (
                        <div key={i} className="flex items-center justify-between px-3 py-1.5 border border-foreground/10 text-xs">
                          <span>#{i + 1} {f.name} ({(f.size / 1024).toFixed(0)}KB)</span>
                          <button type="button" onClick={() => setCh1Files(prev => prev.filter((_, idx) => idx !== i))} className="text-destructive"><X className="w-3 h-3" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="p-4 border-2 border-destructive/30 bg-destructive/5">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={copyrightChecked} onChange={e => setCopyrightChecked(e.target.checked)} className="mt-0.5 accent-primary" />
                    <span className="text-xs text-muted-foreground leading-relaxed">
                      I confirm this content is entirely my original creation. I accept full responsibility for copyright claims. Pirated content will result in permanent ban.
                    </span>
                  </label>
                </div>

                <button type="submit" disabled={!copyrightChecked || !uploadTitle || ch1Files.length === 0 || submitting} className="w-full btn-accent rounded-none py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                  {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {submitting ? 'Submitting...' : 'Submit with Chapter 1 for Review'}
                </button>
              </form>
            </div>
          )}

          {/* CHAPTERS TAB */}
          {activeTab === 'chapters' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-display text-3xl mb-4 tracking-wider">UPLOAD CHAPTER</h2>
                {!selectedMangaId ? (
                  <div className="brutal-card p-6">
                    <p className="text-sm font-semibold mb-3">Select a manhwa to manage chapters:</p>
                    <div className="space-y-2">
                      {(myManga || []).map(m => (
                        <button key={m.id} onClick={() => setSelectedMangaId(m.id)} className="w-full text-left px-4 py-3 border-2 border-foreground/20 hover:border-primary transition-colors flex items-center justify-between group">
                          <span className="font-semibold text-sm">{m.title}</span>
                          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary" />
                        </button>
                      ))}
                      {(!myManga || myManga.length === 0) && (
                        <p className="text-muted-foreground text-sm">No manhwa yet. Create one first!</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3 mb-4">
                      <button onClick={() => setSelectedMangaId(null)} className="text-sm text-muted-foreground hover:text-foreground">&larr; Back</button>
                      <span className="font-bold text-sm">{myManga?.find(m => m.id === selectedMangaId)?.title}</span>
                    </div>

                    <form onSubmit={handleUploadChapter} className="brutal-card p-6 space-y-5">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm font-semibold block mb-1.5">Chapter Number *</label>
                          <input type="number" min={1} value={chapterNumber} onChange={e => setChapterNumber(parseInt(e.target.value) || 1)} className="w-full px-3 py-2.5 bg-background border-2 border-foreground text-sm focus:outline-none focus:border-primary" />
                        </div>
                        <div>
                          <label className="text-sm font-semibold block mb-1.5">Title (optional)</label>
                          <input value={chapterTitle} onChange={e => setChapterTitle(e.target.value)} className="w-full px-3 py-2.5 bg-background border-2 border-foreground text-sm focus:outline-none focus:border-primary" placeholder="e.g. The Beginning" />
                        </div>
                      </div>

                      <div>
                        <label className="text-sm font-semibold block mb-2">Chapter Pages * ({pageFiles.length} selected)</label>
                        <div
                          className="border-2 border-dashed border-foreground p-6 text-center hover:border-primary transition-colors cursor-pointer"
                          onClick={() => pageInputRef.current?.click()}
                        >
                          <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">Click to add page images (JPG, PNG, WEBP)</p>
                          <p className="text-xs text-muted-foreground mt-1">Files will be sorted by name. Upload in order!</p>
                        </div>
                        <input ref={pageInputRef} type="file" accept="image/*" multiple onChange={handlePageFilesChange} className="hidden" />

                        {pageFiles.length > 0 && (
                          <div className="mt-3 space-y-1 max-h-48 overflow-y-auto">
                            {pageFiles.map((f, i) => (
                              <div key={i} className="flex items-center justify-between px-3 py-2 border border-foreground/10 text-xs">
                                <span className="flex items-center gap-2">
                                  <span className="text-muted-foreground font-mono w-6">#{i + 1}</span>
                                  <span className="truncate max-w-[200px]">{f.name}</span>
                                  <span className="text-muted-foreground">({(f.size / 1024).toFixed(0)}KB)</span>
                                </span>
                                <button type="button" onClick={() => removePageFile(i)} className="text-destructive hover:text-destructive/80">
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Schedule publish */}
                      <div className="border border-border/40 rounded-lg p-4 space-y-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} className="accent-primary" />
                          <Clock className="w-4 h-4 text-primary" />
                          <span className="text-sm font-semibold">Schedule for later</span>
                        </label>
                        {scheduleEnabled && (
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs font-semibold block mb-1 text-muted-foreground">Date</label>
                              <input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} min={new Date().toISOString().split('T')[0]} className="w-full px-3 py-2 bg-background border border-border text-sm rounded-lg focus:outline-none focus:border-primary" />
                            </div>
                            <div>
                              <label className="text-xs font-semibold block mb-1 text-muted-foreground">Time</label>
                              <input type="time" value={scheduledTime} onChange={e => setScheduledTime(e.target.value)} className="w-full px-3 py-2 bg-background border border-border text-sm rounded-lg focus:outline-none focus:border-primary" />
                            </div>
                          </div>
                        )}
                      </div>

                      <button type="submit" disabled={pageFiles.length === 0 || uploadingChapter || (scheduleEnabled && (!scheduledDate || !scheduledTime))} className="w-full btn-accent rounded-none py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                        {uploadingChapter && <Loader2 className="w-4 h-4 animate-spin" />}
                        {uploadingChapter ? `Uploading ${pageFiles.length} pages...` : scheduleEnabled ? `Schedule Chapter ${chapterNumber}` : `Upload Chapter ${chapterNumber}`}
                      </button>
                    </form>

                    {/* Existing chapters */}
                    {chapters && chapters.length > 0 && (
                      <div className="brutal-card overflow-hidden mt-6">
                        <div className="px-4 py-3 border-b-2 border-foreground">
                          <h3 className="font-bold text-sm">Existing Chapters ({chapters.length})</h3>
                        </div>
                        {chapters.map(ch => {
                          const scheduled = (ch as any).scheduled_at;
                          const isScheduled = scheduled && !ch.is_published;
                          return (
                            <div key={ch.id} className="flex items-center justify-between px-4 py-3 border-b border-foreground/10 text-sm">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-muted-foreground mr-1">#{ch.chapter_number}</span>
                                <span className="font-semibold">{ch.title || `Chapter ${ch.chapter_number}`}</span>
                                {isScheduled && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold bg-primary/10 text-primary rounded-full">
                                    <Clock className="w-3 h-3" />
                                    {new Date(scheduled).toLocaleDateString()} {new Date(scheduled).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                )}
                                {(() => {
                                  const approvalStatus = (ch as any).approval_status || 'APPROVED';
                                  if (approvalStatus === 'PENDING') return <span className="px-2 py-0.5 text-[10px] font-bold border border-yellow-500/50 bg-yellow-500/10 text-yellow-600">PENDING</span>;
                                  if (approvalStatus === 'REJECTED') return <span className="px-2 py-0.5 text-[10px] font-bold border border-destructive/50 bg-destructive/10 text-destructive">REJECTED</span>;
                                  return <span className="px-2 py-0.5 text-[10px] font-bold border border-green-500/50 bg-green-500/10 text-green-600">APPROVED</span>;
                                })()}
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {(ch as any).chapter_pages?.[0]?.count || 0} pages
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* EARNINGS TAB */}
          {activeTab === 'earnings' && (
            <div>
              <h2 className="text-display text-3xl mb-6 tracking-wider">EARNINGS</h2>
              <CreatorEarnings />
            </div>
          )}

          {/* ANALYTICS TAB */}
          {activeTab === 'analytics' && (
            <div>
              <h2 className="text-display text-3xl mb-6 tracking-wider">ANALYTICS</h2>
              <CreatorAnalytics />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PublisherDashboard;
