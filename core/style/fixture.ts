// Synthetic "VAS-shaped" exported course for the style tests: the SHAPES are
// the designer's (theme power-ups, opener/closer, banners, quote card, Mighty
// video card, attachment donor, band + padding habits), the TEXT is filler.
// Built programmatically so several courses with the same habits can be
// harvested together.

import type { AssetManifest } from '@/core/assets/manifest';
import type { Block, GetCourseDocument } from '@/shared/types/rise';

export const FIX_LIGHT = '#e8efff';
export const FIX_ACCENT = '#0066cc';
export const TYPE_IDS = {
  h1: 'o4wYzDg8LPu2vu2og6Kb9',
  h1White: 'pbjz9J3HX6AujN5SpJsdY',
  h2: 'SUAM2wuds2BfejQ_Xenct',
  h2Gray: 'ewi9XVttH-Zq8MGmZSn4p',
  h3: 'O5i5Lx1DLYwPOyQpUZjm8',
  body: '4usnaQphTiMEpoM8ptfdu',
  boldBody: 'zLD05ERgp7XX-m4KQ5DLV',
} as const;

let seq = 0;
const nid = (): string => `fixid${String(++seq).padStart(20, '0')}`;

function img(courseId: string, name: string, w = 556, h = 556): Record<string, unknown> {
  return {
    image: {
      key: `rise/courses/${courseId}/${name}`,
      type: 'image',
      crushedKey: `rise/courses/${courseId}/c-${name}`,
      dimensions: { originalWidth: w, originalHeight: h },
      isSkipCrush: true,
      originalUrl: name,
      sourcedFrom: 'USER',
      useCrushedKey: false,
    },
  };
}

const COMMON = {
  v: 2,
  paddingLinked: true,
  attachedToNextBlock: false,
  markerColorContrast: 'AUTO',
  snippetColorContrast: 'AUTO',
};

function light(): Record<string, unknown> {
  return { backgroundType: 'COLOR', backgroundColor: FIX_LIGHT };
}
function white(): Record<string, unknown> {
  return { backgroundType: 'LIGHT', backgroundColor: null };
}

function openerParagraph(): Block {
  return {
    id: nid(),
    type: 'text',
    family: 'text',
    variant: 'paragraph',
    items: [
      {
        id: nid(),
        heading: '<div><p style="text-align: center;"><strong>Ritini uz leju!</strong></p></div>',
        paragraph: `<div><p><span class="mighty-type-style-XBs692TTudiieVjN9k99e"><strong>Ritini uz leju!</strong></span></p></div>`,
      },
    ],
    settings: { ...COMMON, textWidth: 92, paddingTop: 1, paddingBottom: 1, quotesInline: false, ...light() },
    globalBlockId: 'g-1',
  };
}

function heading(text: string, cls: string = TYPE_IDS.h1, band: Record<string, unknown> = {}): Block {
  return {
    id: nid(),
    type: 'text',
    family: 'text',
    variant: 'heading',
    items: [{ id: nid(), heading: `<div><p><span class="mighty-type-style-${cls}"><strong>${text}</strong></span></p></div>`, paragraph: '<div><p></p></div>' }],
    settings: { ...COMMON, textWidth: 92, paddingTop: 2, paddingBottom: 0, quotesInline: false, audioPosition: 'bottom', ...band },
  };
}

function headingParagraph(title: string, text: string, band: Record<string, unknown>): Block {
  return {
    id: nid(),
    type: 'text',
    family: 'text',
    variant: 'heading paragraph',
    items: [
      {
        id: nid(),
        heading: `<div><p><span class="mighty-type-style-${TYPE_IDS.h2}"><strong>${title}</strong></span></p></div>`,
        paragraph: `<div><p><span class="mighty-type-style-${TYPE_IDS.body}">${text}</span></p></div>`,
      },
    ],
    settings: { ...COMMON, textWidth: 92, paddingTop: 2, paddingBottom: 0, audioPosition: 'bottom', ...band },
  };
}

function aside(courseId: string, name: string, text: string): Block {
  return {
    id: nid(),
    type: 'image',
    family: 'image',
    variant: 'text aside',
    items: [
      {
        id: nid(),
        media: img(courseId, name),
        caption: '',
        paragraph: `<div><p><span class="mighty-type-style-${TYPE_IDS.body}">${text}</span></p></div>`,
      },
    ],
    settings: {
      ...COMMON,
      opacity: 0.5,
      imageSize: 'small',
      mightyMods: [
        {
          data: { ratio: 4, alignItems: 'start', hideCaption: false, clipAsCircle: false, contentWidth: 'lg', insidePadding: 'md', alignImageMobile: 'center', imageBorderRadius: 0, outsideLeftPadding: 'sm', outsideRightPadding: 'sm', columnStackingMobile: 'column-reverse' },
          tagName: 'mighty-rise-block-mod-image-and-text',
        },
      ],
      paddingTop: 3,
      paddingBottom: 2,
      zoomOnClick: false,
      opacityColor: '#000000',
      quotesInline: false,
      imagePosition: 'right',
    },
  };
}

function hero(courseId: string, name: string): Block {
  return {
    id: nid(),
    type: 'image',
    family: 'image',
    variant: 'hero',
    items: [{ id: nid(), media: img(courseId, name, 1600, 600), caption: '' }],
    settings: { ...COMMON, backgroundType: 'LIGHT', cornerRadius: 0, opacity: 0.5, opacityColor: '#000000', paddingTop: 0, paddingBottom: 3, quotesInline: false, zoomOnClick: true },
  };
}

function cont(title: string, band: Record<string, unknown>, extra: Record<string, unknown> = {}): Block {
  return {
    id: nid(),
    type: 'divider',
    family: 'continue',
    variant: 'continue',
    items: [{ id: nid(), type: '', title, buttonColor: 'brand', completeHint: 'Pabeidz augstāk esošo saturu, lai turpinātu.' }],
    settings: {
      ...COMMON,
      mightyMods: [
        {
          data: { border: 'none', fontSize: 17, dropShadow: 'none', labelColor: '#ffffff', borderColor: '#000000', labelCasing: 'none', borderRadius: 30, letterSpacing: 10, backgroundColor: FIX_ACCENT },
          tagName: 'mighty-rise-block-mod-button-style',
        },
      ],
      paddingTop: 3,
      paddingBottom: 7,
      continueRadius: 30,
      ...band,
      ...extra,
    },
  };
}

function paragraph(text: string, band: Record<string, unknown>, cls: string | null = TYPE_IDS.body): Block {
  return {
    id: nid(),
    type: 'text',
    family: 'text',
    variant: 'paragraph',
    items: [{ id: nid(), paragraph: cls ? `<div><p><span class="mighty-type-style-${cls}">${text}</span></p></div>` : `<div><p>${text}</p></div>` }],
    settings: { ...COMMON, textWidth: 92, paddingTop: 1, paddingBottom: 0, quotesInline: false, ...band },
  };
}

export const FIX_VIDEO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; background: #0066CC; }
    .rise-card { max-width: 960px; background: #fff; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="rise-block"><div class="rise-card"><div class="video-wrap">
    <iframe id="yt" title="video" src="https://www.youtube-nocookie.com/embed/__ID__?enablejsapi=1&rel=0&playsinline=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>
  </div></div></div>
  <script>const JUMP_BEFORE_END_SECONDS = 2;</script>
</body>
</html>`;

function video(youtubeId: string, createdAt: string): Block {
  return {
    id: nid(),
    type: 'interactive',
    family: 'interactive',
    variant: 'tabs',
    items: [
      { id: nid(), title: 'Mighty placeholder', description: '<p>Mighty placeholder for the Interactive HTML block</p>' },
      { id: nid(), title: 'Learn more', description: '<p>This course is using Mighty.</p>' },
    ],
    settings: {
      ...COMMON,
      paddingTop: 0,
      paddingBottom: 2,
      zoomOnClick: true,
      quotesInline: false,
      backgroundType: 'ACCENT',
      entranceAnimation: true,
      mightyBlockConfig: {
        id: '7e9538a6-8cc7-4808-ba94-88b17f9e34e5',
        data: { injectCss: '', inputMode: 'direct', directHtml: FIX_VIDEO_HTML.replace('__ID__', youtubeId), showBorder: false, autocomplete: true, injectJavascript: '', interactiveWidth: 'xl' },
        name: 'Interactive HTML',
        tagName: 'mighty-interactive-html',
        version: 0,
        blockOptions: { layout: 'full-width', autocomplete: true },
      },
      customBackgroundColorContrast: 'AUTO',
    },
    createdAt,
  };
}

function quote(courseId: string, text: string): Block {
  return {
    id: nid(),
    type: 'quote',
    family: 'quote',
    variant: 'd',
    items: [
      {
        id: '28df7c97-871c-44ce-99b5-63966d176f5a',
        name: '<div><p></p></div>',
        avatar: { media: { image: { key: `rise/courses/${courseId}/edu.svg`, type: 'image', crushedKey: `rise/courses/${courseId}/c-edu.svg`, isSkipCrush: false, originalUrl: 'edu.svg', sourcedFrom: 'USER', useCrushedKey: true } } },
        paragraph: `<div><p><span class="mighty-type-style-${TYPE_IDS.h1}"><strong>Tēmas padziļināšanai</strong></span></p><p><span class="mighty-type-style-${TYPE_IDS.body}">${text}</span></p></div>`,
        background: { media: { image: { key: 'assets/rise/assets/block-defaults/quote_background.jpg', src: 'https://cdn.articulate.com/assets/rise/assets/block-defaults/quote_background.jpg', type: 'image', originalUrl: 'quote_background.jpg', sourcedFrom: 'DEFAULT' } } },
      },
    ],
    settings: { ...COMMON, avatar: true, avatarSize: 16, paddingTop: 0, quoteWidth: 92, quotePadding: 2, quotesInline: true, audioPosition: 'bottom', paddingBottom: 0, ...light() },
  };
}

function buttons(band: Record<string, unknown>): Block {
  return {
    id: nid(),
    type: 'interactive',
    family: 'buttons',
    variant: 'button stack',
    items: [{ id: nid(), type: 'link', label: 'Resurss', description: '<div><p>Apraksts</p></div>', destination: 'https://example.eu/' }],
    settings: {
      ...COMMON,
      mightyMods: [{ data: { alignButton: 'right', contentWidth: 'large', hideDescription: false }, tagName: 'mighty-rise-block-mod-button-layout' }],
      paddingTop: 0,
      buttonWidth: 28,
      quotesInline: false,
      buttonSpacing: 5,
      paddingBottom: 4,
      ...band,
    },
  };
}

function kc(band: Record<string, unknown>, colors: boolean): Block {
  return {
    id: nid(),
    type: 'knowledgeCheck',
    family: 'knowledgeCheck',
    variant: 'multiple choice',
    items: [
      {
        id: 'e4bf61e3-6ca6-4dff-bcce-90112f64cb73',
        type: 'MULTIPLE_CHOICE',
        title: '<div><p>Jautājums?</p></div>',
        answers: [
          { id: '48133af3-eb33-451a-a4c6-e743e61051d1', title: '<div><p>A</p></div>', correct: true },
          { id: '4343bfef-aeef-4f6a-9daf-3bcc83ad4ede', title: '<div><p>B</p></div>', correct: false },
        ],
      },
    ],
    settings: {
      ...COMMON,
      paddingTop: 3,
      paddingBottom: 3,
      quotesInline: false,
      knowledgeCheckWidth: 92,
      ...(colors ? { correctAnswerColor: FIX_ACCENT, incorrectAnswerColor: '#434656' } : {}),
      ...band,
    },
  };
}

function overlay(courseId: string, name: string, caption: string): Block {
  return {
    id: nid(),
    type: 'image',
    family: 'image',
    variant: 'text overlay',
    items: [{ id: nid(), media: img(courseId, name, 2464, 792), caption, paragraph: '' }],
    settings: {
      ...COMMON,
      opacity: '0.1',
      cardMode: 'WHITE',
      paddingTop: 0,
      zoomOnClick: true,
      opacityColor: FIX_ACCENT,
      quotesInline: false,
      paddingBottom: 0,
      backgroundType: 'LIGHT',
      customPaddingTop: 0,
      entranceAnimation: true,
      customPaddingBottom: 0,
      customBackgroundColorContrast: 'AUTO',
    },
    background: {},
    data: {},
  };
}

function attachment(courseId: string): Block {
  return {
    id: nid(),
    type: 'multimedia',
    family: 'multimedia',
    variant: 'attachment',
    items: [
      { id: '49ebeedd-530d-4367-8ceb-8b2a91e93a06', media: { attachment: { key: `rise/courses/${courseId}/file.pdf`, size: 343540, type: 'attachment', filename: 'file.pdf', mimeType: 'application/pdf', originalUrl: 'Kontrolsaraksts.pdf' } } },
      { id: '4887a49a-fbe1-4383-84ec-ebe286da850a', media: { attachment: { key: `rise/courses/${courseId}/icon.svg`, size: 1231, filename: 'icon.svg', mimeType: 'image/svg+xml', originalUrl: 'Group 1000007128.svg' } } },
    ],
    settings: {
      ...COMMON,
      mightyMods: [
        { data: { border: 'none', iconSize: 40, textColor: '#0066CC', alignItems: 'center', dropShadow: 'default', borderColor: '#000000', borderRadius: 3, spaceBetween: 23, backgroundColor: '#E8EFFF', overrideBackgroundColor: true }, tagName: 'mighty-rise-block-mod-attachment-appearance' },
        { data: { image: '4887a49a-fbe1-4383-84ec-ebe286da850a' }, tagName: 'mighty-rise-block-mod-attachment-icon' },
      ],
      paddingTop: 0,
      quotesInline: false,
      paddingBottom: 6,
    },
  };
}

function theme(title: string): Record<string, unknown> {
  const ts = (id: string, name: string, desktop: number, color: string, fontWeight: string | undefined) => ({
    id,
    name,
    color,
    fontSizes: { mobile: null, tablet: null, desktop },
    fontFamily: 'Source Sans Pro',
    ...(fontWeight ? { fontWeight } : {}),
  });
  return {
    themeId: 'organic',
    colorAccent: FIX_ACCENT,
    blockCorners: 'ROUNDED',
    navigationType: 'SIDEBAR',
    headingTypefaceId: '_vy9IVqRPwz6wQlKi0wsA9dsYpZ7gsQ3',
    bodyTypefaceId: 'Wstu1lVkR_rUsAuU6x1N_UImwchzygj2',
    uiTypefaceId: '_vy9IVqRPwz6wQlKi0wsA9dsYpZ7gsQ3',
    coverImage: 'https://cdn.articulate.com/assets/rise/assets/themes/classic/cover-image/14_cities.jpg',
    mightyMods: [{ data: { typefaces: [{ id: 'NsX', name: 'Lexend VAS', default: false, fonts: [{ id: 'f1', key: 'rise/fonts/abc-Lexend-Bold.woff', original: 'Lexend-Bold.woff', style: 'bold' }] }] }, tagName: 'mighty-rise-theme-mod-font-families' }],
    mightyPowerups: [
      { tagName: 'mighty-powerup-custom-code', data: { snippets: [{ id: 's1', name: 'Bulletpoints', scope: 'course', enabled: true, customCss: '.block-list__bullet svg { display:none }' }] } },
      {
        tagName: 'mighty-powerup-global-styles',
        data: {
          type: {
            styles: {
              customStyles: [
                ts(TYPE_IDS.h1, 'H1', 34, `var(--mighty-theme-color, ${FIX_ACCENT})`, 'heavy'),
                ts(TYPE_IDS.h1White, 'H1 White', 34, '#FFFFFF', 'heavy'),
                ts(TYPE_IDS.h2, 'H2', 26, `var(--mighty-theme-color, ${FIX_ACCENT})`, 'heavy'),
                ts(TYPE_IDS.h2Gray, 'H2 gray', 26, 'var(--mighty-color-style-bkuU, #434656)', 'heavy'),
                ts(TYPE_IDS.h3, 'H3', 20, 'var(--mighty-color-style-bkuU, #434656)', 'heavy'),
                ts(TYPE_IDS.body, 'Body text', 19, 'var(--mighty-color-style-bkuU, #434656)', undefined),
                ts(TYPE_IDS.boldBody, 'Bold body text', 19, 'var(--mighty-color-style-bkuU, #434656)', 'heavy'),
              ],
            },
            mappings: { blockMappings: [] },
          },
          color: { customStyles: [{ id: 'bkuU', hexValue: '#434656', nickname: 'Dark gray' }] },
        },
      },
      { tagName: 'mighty-powerup-published-course-title', data: { publishedCourseTitle: `1. ${title}` } },
    ],
  };
}

export interface FixtureOptions {
  /** Knowledge checks carry the custom answer colours (VAS 1.1 habit). */
  kcColors?: boolean;
  /** One lesson opens with a hero picture where the others have a Continue. */
  heroOpener?: boolean;
  /** Lesson icon on content lessons. */
  icon?: string | null;
}

/** A VAS-shaped course with three content lessons and one section divider. */
export function vasLikeCourse(courseId: string, title: string, opts: FixtureOptions = {}): {
  doc: GetCourseDocument;
  assetManifest: AssetManifest;
} {
  const chapters = ['Pirmā tēma', 'Otrā tēma', 'Trešā tēma'];
  const lessons = chapters.map((ch, i) => {
    const n = i + 1;
    const items: Block[] = [
      openerParagraph(),
      heading(ch),
      aside(courseId, `${n}-0.png`, `Ievads par tēmu ${n}.`),
      // VAS 1.2 habit: some lessons follow the intro with a full-width picture
      // instead of the Continue — content, never part of the opener donor.
      ...(opts.heroOpener && i === 1 ? [hero(courseId, 'temas.png')] : [cont('TURPINĀT', white(), { paddingTop: 0 })]),
      paragraph('Noskaties video.', { backgroundType: 'ACCENT', backgroundColor: null }, null),
      video(`vid${n}AAAAAAAA`, `2026-09-0${n}T10:00:00Z`),
      quote(courseId, 'Izpēti piemērus.'),
      buttons(light()),
      cont('Turpināt', light()),
      heading('Salīdzinājums', TYPE_IDS.h2),
      paragraph('Teksts.', {}),
      headingParagraph('Tagad praksē', 'Abi piemēri.', light()),
      ...(i < 2 ? [overlay(courseId, 'N-banner.jpg', '<div><p><strong>Uzdevums.</strong></p><p><strong>Kurš variants?</strong></p></div>')] : []),
      kc(white(), opts.kcColors ?? false),
      kc(light(), opts.kcColors ?? false),
      kc(white(), opts.kcColors ?? false),
      ...(i === 0 ? [attachment(courseId)] : []),
      overlay(courseId, '01.jpg', `<div><p style="line-height: 1.3;"><span class="mighty-type-style-${TYPE_IDS.h1White}"><strong>Kopsavilkums</strong></span></p></div>`),
      paragraph('Kopsavilkuma teksts.', {}),
      cont(i < 2 ? `Nākamā tēma: ${chapters[i + 1]}` : 'Nākamā nodaļa: Cita', {}),
    ];
    return {
      id: `L${n}-${courseId}`,
      courseId,
      type: 'blocks',
      position: i < 1 ? i : i + 1,
      title: `${n}.${n}. ${ch}`,
      ...(opts.icon === undefined ? { icon: 'Article' } : opts.icon ? { icon: opts.icon } : {}),
      items,
    };
  });
  lessons.splice(1, 0, { id: `S-${courseId}`, courseId, type: 'section', position: 1, title: '1. modulis | Nodaļa 1/4', items: [] });

  const doc: GetCourseDocument = {
    course: {
      id: courseId,
      title,
      type: null,
      description: '<div><p></p></div>',
      theme: theme(title),
      headingTypefaceId: 'tf-SourceSansPro',
      bodyTypefaceId: 'tf-SourceSansPro',
      uiTypefaceId: 'tf-Inter',
      labelSetId: 'OB-YT24aYbEb8J5atoVsQFJY',
      coverImage: { alpha: 60, media: img(courseId, 'cover.png', 2000, 2000) },
      cardImage: {},
      media: img(courseId, 'logo.svg'),
      lessonHeaderImage: {},
      settings: {},
      lessons: lessons.map((l) => l.id),
    } as GetCourseDocument['course'],
    lessons,
  };

  const keys = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') Object.values(o).forEach(walk);
    else if (typeof o === 'string' && o.startsWith(`rise/courses/${courseId}/`)) keys.add(o);
  };
  walk(doc);
  const assets = [...keys].map((key) => {
    const name = key.split('/').pop()!;
    const ext = name.split('.').pop()!;
    const hash = `h${Buffer.from(key).toString('hex').slice(0, 60)}`;
    return { key, kind: ext === 'pdf' ? ('media-other' as const) : ('media-image' as const), hash, ext, file: `assets/${hash}.${ext}`, size: 1000 };
  });
  return {
    doc,
    assetManifest: {
      ownerType: 'course',
      ownerId: courseId,
      generatedAt: '2026-09-13T00:00:00Z',
      keyCount: assets.length,
      assets,
      failed: [],
      orphanCount: 0,
      complete: true,
    },
  };
}
