const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, MessageFlags,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID; // اختياري: يسجل الأمر فوراً في سيرفر واحد
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const DATA_FILE = 'data.json';
const MAX_RECENT = 10;
const EPHEMERAL = MessageFlags.Ephemeral;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ---------------- التخزين (مفضلة + مؤخراً لكل مستخدم) ----------------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function save(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function userData(data, uid) {
  if (!data[uid]) data[uid] = { favorites: [], recent: [] };
  return data[uid];
}
function pick(s) { return { id: s.id, title: s.title, url: s.url }; }
function addRecent(uid, song) {
  const data = load();
  const u = userData(data, uid);
  u.recent = [pick(song), ...u.recent.filter((s) => s.id !== song.id)].slice(0, MAX_RECENT);
  save(data);
}
function toggleFavorite(uid, song) {
  const data = load();
  const u = userData(data, uid);
  const exists = u.favorites.some((s) => s.id === song.id);
  u.favorites = exists ? u.favorites.filter((s) => s.id !== song.id) : [...u.favorites, pick(song)];
  save(data);
  return !exists;
}

// ---------------- البحث (yt-dlp) ----------------
function search(query) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      [`ytsearch5:${query}`, '--flat-playlist', '--print', '%(id)s\t%(title)s', '--no-warnings'],
      { timeout: 30000 },
      (err, out) => {
        if (err) return reject(err);
        resolve(
          out.trim().split('\n').filter(Boolean).map((line) => {
            const [id, ...t] = line.split('\t');
            return { id, title: t.join('\t') || 'بدون عنوان', url: `https://www.youtube.com/watch?v=${id}` };
          }),
        );
      },
    );
  });
}

// ---------------- المشغّل لكل سيرفر ----------------
const players = new Map();
const pickCache = new Map(); // userId -> قائمة الأغاني اللي تظهر له في القائمة

class GuildPlayer {
  constructor(guild) {
    this.guild = guild;
    this.queue = [];
    this.current = null;
    this.loop = false;
    this.volume = 0.5;
    this.channel = null;
    this.message = null;
    this.connection = null;
    this.resource = null;
    this.proc = null;
    this.suppress = false;
    this.audio = createAudioPlayer();
    this.audio.on('stateChange', (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Idle && oldS.status !== AudioPlayerStatus.Idle && !this.suppress) {
        this.advance().catch(console.error);
      }
    });
    this.audio.on('error', (e) => console.error('audio error:', e.message));
  }

  embed() {
    if (!this.current) return new EmbedBuilder().setTitle('⏹ لا توجد أغنية حالياً').setColor(0x2b2d31);
    return new EmbedBuilder()
      .setTitle('🎶 يتم التشغيل الآن')
      .setDescription(`[${this.current.title}](${this.current.url})`)
      .setColor(0x1db954)
      .addFields(
        { name: '🔊 الصوت', value: `${Math.round(this.volume * 100)}%`, inline: true },
        { name: '🔁 تكرار تلقائي', value: this.loop ? 'مفعّل' : 'متوقف', inline: true },
        { name: '📃 في الانتظار', value: String(this.queue.length), inline: true },
      );
  }

  rows() {
    const b = (id, label, emoji, style = ButtonStyle.Secondary) =>
      new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
    return [
      new ActionRowBuilder().addComponents(
        b('p_stop', 'إيقاف', '⏹', ButtonStyle.Danger),
        b('p_restart', 'إعادة', '🔄'),
        b('p_fav', 'مفضلة', '⭐'),
        b('p_loop', 'تكرار تلقائي', '🔁', this.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        b('p_voldown', 'خفض الصوت', '🔉'),
        b('p_volup', 'رفع الصوت', '🔊'),
        b('p_skip', 'تخطي', '⏭', ButtonStyle.Primary),
      ),
    ];
  }

  async refresh() {
    const payload = { embeds: [this.embed()], components: this.current ? this.rows() : [] };
    if (this.message) {
      try { await this.message.edit(payload); return; } catch { this.message = null; }
    }
    if (this.channel) this.message = await this.channel.send(payload);
  }

  killProc() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }

  stopCurrent() {
    this.suppress = true; // يمنع تشغيل التالي تلقائياً
    this.audio.stop(true);
    this.suppress = false;
    this.killProc();
  }

  async play(song) {
    this.current = song;
    this.killProc();
    const proc = spawn(YTDLP, ['-f', 'bestaudio/best', '--no-playlist', '-q', '-o', '-', song.url], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    proc.on('error', (e) => console.error('yt-dlp:', e.message));
    proc.stdout.on('error', () => {});
    this.proc = proc;
    const resource = createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
    resource.volume.setVolume(this.volume);
    this.resource = resource;
    this.audio.play(resource);
    if (song.by) addRecent(song.by, song);
    await this.refresh();
  }

  async advance() {
    if (this.loop && this.current) return this.play(this.current);
    if (this.queue.length) return this.play(this.queue.shift());
    this.current = null;
    this.killProc();
    await this.refresh();
  }
}

function getPlayer(guild) {
  if (!players.has(guild.id)) players.set(guild.id, new GuildPlayer(guild));
  return players.get(guild.id);
}

// يشغّل الأغنية فوراً إذا ما في شي شغال، وإلا يضيفها للانتظار (تشتغل لما تضغط تخطي)
async function enqueue(interaction, song) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: 'ادخل روم صوتي أول 🎧', flags: EPHEMERAL });
  }
  await interaction.deferReply({ flags: EPHEMERAL });
  const p = getPlayer(interaction.guild);
  p.channel = interaction.channel;
  song = { ...song, by: interaction.user.id };

  if (!p.connection || p.connection.state.status === VoiceConnectionStatus.Destroyed) {
    p.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });
    p.connection.subscribe(p.audio);
    try {
      await entersState(p.connection, VoiceConnectionStatus.Ready, 15000);
    } catch {
      p.connection.destroy();
      p.connection = null;
      return interaction.editReply('ما قدرت أدخل الروم الصوتي 😕');
    }
  }

  if (p.current) {
    p.queue.push(song);
    await interaction.editReply(`✅ أضفت **${song.title}** للانتظار، اضغط ⏭ تخطي لتشغيلها.`);
    await p.refresh();
  } else {
    await p.play(song);
    await interaction.editReply(`▶️ شغّلت **${song.title}**`);
  }
}

// ---------------- واجهات ----------------
function mainRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m_new').setLabel('استماع أغنية جديدة').setEmoji('🎵').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('m_favs').setLabel('الأغاني المفضلة').setEmoji('⭐').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('m_recent').setLabel('الأغاني مؤخراً').setEmoji('🕘').setStyle(ButtonStyle.Secondary),
  );
}

function selectRow(songs, placeholder) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('pick')
      .setPlaceholder(placeholder)
      .addOptions(songs.slice(0, 25).map((s) => ({ label: s.title.slice(0, 100), value: s.id }))),
  );
}

// ---------------- التعامل مع التفاعلات ----------------
async function handle(interaction) {
  // أمر /play
  if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
    const embed = new EmbedBuilder().setTitle('🎧 بوت الأغاني').setDescription('اختر من الأزرار تحت').setColor(0x5865f2);
    return interaction.reply({ embeds: [embed], components: [mainRow()] });
  }

  // نافذة البحث
  if (interaction.isModalSubmit() && interaction.customId === 'm_search') {
    await interaction.deferReply({ flags: EPHEMERAL });
    let songs;
    try { songs = await search(interaction.fields.getTextInputValue('q')); }
    catch (e) { console.error(e.message); return interaction.editReply('صار خطأ في البحث، تأكد إن yt-dlp منصّب.'); }
    if (!songs.length) return interaction.editReply('ما لقيت نتائج 😕');
    pickCache.set(interaction.user.id, songs);
    return interaction.editReply({ content: 'اختر الأغنية:', components: [selectRow(songs, 'اختر الأغنية')] });
  }

  // اختيار أغنية من القائمة
  if (interaction.isStringSelectMenu() && interaction.customId === 'pick') {
    const song = (pickCache.get(interaction.user.id) || []).find((s) => s.id === interaction.values[0]);
    if (!song) return interaction.reply({ content: 'انتهت القائمة، افتح /play من جديد.', flags: EPHEMERAL });
    return enqueue(interaction, song);
  }

  if (!interaction.isButton()) return;
  const id = interaction.customId;

  // أزرار القائمة الرئيسية
  if (id === 'm_new') {
    const modal = new ModalBuilder().setCustomId('m_search').setTitle('استماع أغنية جديدة').addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('q').setLabel('اسم الأغنية أو الفنان')
          .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true),
      ),
    );
    return interaction.showModal(modal);
  }
  if (id === 'm_favs' || id === 'm_recent') {
    const u = userData(load(), interaction.user.id);
    const songs = id === 'm_favs' ? u.favorites : u.recent;
    if (!songs.length) {
      return interaction.reply({
        content: id === 'm_favs' ? 'ما عندك أغاني مفضلة بعد ⭐' : 'ما سمعت شي مؤخراً 🕘',
        flags: EPHEMERAL,
      });
    }
    pickCache.set(interaction.user.id, songs);
    return interaction.reply({
      content: id === 'm_favs' ? 'مفضلتك:' : 'سمعتها مؤخراً:',
      components: [selectRow(songs, 'اختر أغنية')],
      flags: EPHEMERAL,
    });
  }

  // أزرار التحكم
  if (id.startsWith('p_')) {
    const p = players.get(interaction.guildId);
    if (!p || !p.current) {
      return interaction.reply({ content: 'ما في أغنية شغالة.', flags: EPHEMERAL });
    }
    if (id === 'p_fav') {
      const added = toggleFavorite(interaction.user.id, p.current);
      return interaction.reply({ content: added ? '⭐ انضافت للمفضلة' : '🗑 انحذفت من المفضلة', flags: EPHEMERAL });
    }
    await interaction.deferUpdate();
    if (id === 'p_stop') {
      p.queue = [];
      p.stopCurrent();
      p.current = null;
      return p.refresh();
    }
    if (id === 'p_restart') {
      const song = p.current;
      p.stopCurrent();
      return p.play(song);
    }
    if (id === 'p_loop') {
      p.loop = !p.loop;
      return p.refresh();
    }
    if (id === 'p_volup' || id === 'p_voldown') {
      p.volume = Math.round(Math.min(1.5, Math.max(0, p.volume + (id === 'p_volup' ? 0.1 : -0.1))) * 100) / 100;
      if (p.resource && p.resource.volume) p.resource.volume.setVolume(p.volume);
      return p.refresh();
    }
    if (id === 'p_skip') {
      p.stopCurrent();
      if (p.queue.length) return p.play(p.queue.shift());
      p.current = null;
      return p.refresh();
    }
  }
}

client.on(Events.InteractionCreate, (interaction) => {
  handle(interaction).catch((e) => {
    console.error(e);
    try {
      if (interaction.deferred || interaction.replied) interaction.followUp({ content: 'صار خطأ 😕', flags: EPHEMERAL });
      else interaction.reply({ content: 'صار خطأ 😕', flags: EPHEMERAL });
    } catch {}
  });
});

client.once(Events.ClientReady, async () => {
  const commands = [{ name: 'play', description: 'قائمة الموسيقى' }];
  if (GUILD_ID) await client.guilds.cache.get(GUILD_ID)?.commands.set(commands);
  else await client.application.commands.set(commands);
  console.log(`جاهز: ${client.user.tag}`);
});

client.login("MTU2ODkxMjc1MDY1NzI3ODAwMg.GanS4s.L4fyVtrUROGugMujwxoRtAl17Du9RRD9jV9Tmc");
