import { useEffect } from 'react';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import type { AvatarPose } from '@shared/avatar-poses';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from '@shared/avatar-shapes';
import { useBotPose } from './pose';
import { ModelBadge, useLiveModel } from './ModelBadge';

export function shapeDef(shape: AvatarShape | string): ShapeDef {
  return SHAPES[shape as AvatarShape] ?? SHAPES.blob;
}

/** Shapes offered in the Create New Bot picker (rows of 5/5/3). */
export const PICKER_SHAPES: AvatarShape[] = ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'];

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. The body fills the slot; the ring draws just outside it. */
  size: number;
  star?: boolean;
  /** Selected-shape ring (white gap + gray outline following the silhouette). */
  ring?: boolean;
  /** A picture to show instead of the shape (drawn as a circle). */
  image?: string | null;
  /** What the bot is doing: the shape's eyes and a small motion follow it. */
  mood?: AvatarPose;
  className?: string;
  title?: string;
}

/** The part of the 100×100 drawing box that maps onto the slot. */
const VIEW = { x: 8, w: 84 };
/** Calm plain white eyes (no pupils), matching the phone apps (changed 2026-11-22). */
const EYE_SCALE = 0.78;

/**
 * The shape's two eyes for a mood (option 6 of the Muse research): calm ovals by default, and
 * looking up, narrowed, closed, smiling or squeezed for the other states. Plain SVG, nothing generated.
 */
function Eyes({ def, mood = 'idle' }: { def: ShapeDef; mood?: AvatarPose }) {
  const { y, dx, s } = def.eyes;
  const rx = 7 * s * EYE_SCALE;
  const ry = 9 * s * EYE_SCALE;
  const line = { fill: 'none', stroke: '#FFFFFF', strokeWidth: 2.6 * s, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <g className="bot-avatar__eyes">
      {[-1, 1].map((side) => {
        const cx = 50 + side * dx;
        switch (mood) {
          case 'happy':
          case 'celebrating':
            return <path key={side} d={`M ${cx - rx} ${y + ry * 0.35} Q ${cx} ${y - ry * 0.9} ${cx + rx} ${y + ry * 0.35}`} {...line} />;
          case 'sleeping':
            return <path key={side} d={`M ${cx - rx} ${y} Q ${cx} ${y + ry * 0.7} ${cx + rx} ${y}`} {...line} />;
          case 'oops':
            return <path key={side} d={`M ${cx - side * rx * 0.8} ${y - ry * 0.55} L ${cx + side * rx * 0.6} ${y} L ${cx - side * rx * 0.8} ${y + ry * 0.55}`} {...line} />;
          case 'working':
            return <ellipse key={side} cx={cx} cy={y + ry * 0.25} rx={rx} ry={ry * 0.5} fill="#FFFFFF" />;
          case 'thinking':
            return <ellipse key={side} cx={cx + rx * 0.35} cy={y - ry * 0.3} rx={rx * 0.82} ry={ry * 0.82} fill="#FFFFFF" />;
          case 'listening':
          case 'waiting':
            return <ellipse key={side} cx={cx} cy={y - ry * 0.05} rx={rx * 1.08} ry={ry * 1.14} fill="#FFFFFF" />;
          default:
            return <ellipse key={side} cx={cx} cy={y} rx={rx} ry={ry} fill="#FFFFFF" />;
        }
      })}
    </g>
  );
}

export function BotAvatar({ shape, color, size, star, ring, image, mood, className, title }: Props) {
  const def = shapeDef(shape);
  const fill = palette(color).fill;
  const unit = VIEW.w / size; // viewBox units per CSS px
  const moodClass = mood && mood !== 'idle' ? ` is-${mood}` : '';
  return (
    <span className={`bot-avatar${moodClass} ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      {image ? (
        <img key={image} className="bot-avatar__img" src={image} alt="" width={size} height={size} draggable={false} />
      ) : (
        <svg width={size} height={size} viewBox={`${VIEW.x} ${VIEW.x} ${VIEW.w} ${VIEW.w}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden>
          {ring && <path d={def.d} fill="#1C1C1C3D" stroke="#1C1C1C3D" strokeWidth={unit * 2 * 3.4} strokeLinejoin="round" />}
          {ring && <path d={def.d} fill="#FFFFFF" stroke="#FFFFFF" strokeWidth={unit * 2 * 2.4} strokeLinejoin="round" />}
          <path d={def.d} fill={fill} />
          <Eyes def={def} mood={mood} />
        </svg>
      )}
      {star && (
        <span className="bot-avatar__star" style={{ width: size * 0.2667, height: size * 0.2667 }}>
          <Icon name="star" size={size * 0.1333} color="#FFFFFF" />
        </span>
      )}
    </span>
  );
}

type AvatarBot = Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> & Partial<Pick<Bot, 'id' | 'avatarImageUrl' | 'avatarPoses' | 'lastActivityAt'>> & { isPrimary?: boolean };

const preloaded = new Set<string>();
const headUrl = (url: string) => `${url}${url.includes('?') ? '&' : '?'}crop=head`;

/**
 * A bot as it looks right now: its picture in the pose that fits what it is doing (when it has
 * poses), its picture, or its shape with eyes that follow its state. `still` turns that off.
 */
export function BotAvatarFor({ bot, size, star, className, still, head, badge }: {
  bot: AvatarBot; size: number; star?: boolean; className?: string; still?: boolean;
  /** Show a picture's head and shoulders, centred on the face (the server's ?crop=head), for list-size tiles. */
  head?: boolean;
  /** While the bot works, hang a small chip off the picture with the model and effort it is using (ModelBadge). */
  badge?: boolean;
}) {
  const model = useLiveModel(badge ? bot.id : undefined);
  const pose = useBotPose(still ? undefined : bot.id, bot.lastActivityAt);
  const poses = bot.avatarPoses ?? {};
  // Fetch every pose once so switching between them never flashes.
  useEffect(() => {
    for (const raw of Object.values(poses)) {
      const url = raw && (head ? headUrl(raw) : raw);
      if (url && !preloaded.has(url)) { preloaded.add(url); new Image().src = url; }
    }
  }, [poses, head]);
  const picked = bot.avatarImageUrl ? (pose && poses[pose]) || poses.idle || bot.avatarImageUrl : null;
  const image = picked && head ? headUrl(picked) : picked;
  const pic = <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={star} image={image} mood={pose ?? undefined} className={className} title={bot.name} />;
  if (!badge) return pic;
  return <span className="model-badge-host" style={{ width: size, height: size }}>{pic}{model && <ModelBadge model={model} size={size} />}</span>;
}
