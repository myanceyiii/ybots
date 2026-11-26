import { Image, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Path } from 'react-native-svg';
import shapes from '../shapes.json';
import { botColor } from '../theme';
import type { Bot } from '../api';
import { useBotPose } from '../live';
import type { AvatarPose } from '../poses';

type ShapeDef = { d: string; eyes: { y: number; dx: number; s: number } };
const SHAPES = shapes as Record<string, ShapeDef>;

/** Calm plain white eyes (the look since 2026-11-22), or the older googly eyes with pupils. */
export const EYE_STYLE: 'googly' | 'calm' = 'calm';

/**
 * A bot's character: the project's own shapes (server/src/avatar-shapes.ts) with two eyes. `mood`
 * changes the eyes (looking up, narrowed, closed, smiling, squeezed), as on the web.
 */
export function BotShape({ shape, color, size, mood }: { shape: string; color: string; size: number; mood?: AvatarPose }) {
  const def = SHAPES[shape] ?? SHAPES.blob;
  const { y, dx, s } = def.eyes;
  const calm = EYE_STYLE === 'calm';
  const pupils = !calm && size >= 26;
  const k = calm ? 0.78 : 1;
  if (calm && mood && mood !== 'idle' && mood !== 'talking') {
    const rx = 7 * s * k, ry = 9 * s * k;
    const line = { fill: 'none', stroke: '#FFFFFF', strokeWidth: 2.6 * s, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
    return (
      <Svg width={size} height={size} viewBox="8 8 84 84">
        <Path d={def.d} fill={botColor[color] ?? botColor.black} />
        {[-1, 1].map((side) => {
          const cx = 50 + side * dx;
          if (mood === 'happy' || mood === 'celebrating') return <Path key={side} d={`M ${cx - rx} ${y + ry * 0.35} Q ${cx} ${y - ry * 0.9} ${cx + rx} ${y + ry * 0.35}`} {...line} />;
          if (mood === 'sleeping') return <Path key={side} d={`M ${cx - rx} ${y} Q ${cx} ${y + ry * 0.7} ${cx + rx} ${y}`} {...line} />;
          if (mood === 'oops') return <Path key={side} d={`M ${cx - side * rx * 0.8} ${y - ry * 0.55} L ${cx + side * rx * 0.6} ${y} L ${cx - side * rx * 0.8} ${y + ry * 0.55}`} {...line} />;
          if (mood === 'working') return <Ellipse key={side} cx={cx} cy={y + ry * 0.25} rx={rx} ry={ry * 0.5} fill="#FFFFFF" />;
          if (mood === 'thinking') return <Ellipse key={side} cx={cx + rx * 0.35} cy={y - ry * 0.3} rx={rx * 0.82} ry={ry * 0.82} fill="#FFFFFF" />;
          if (mood === 'searching') return <Ellipse key={side} cx={cx - rx * 0.35} cy={y} rx={rx * 0.9} ry={ry * 0.9} fill="#FFFFFF" />;
          return <Ellipse key={side} cx={cx} cy={y - ry * 0.05} rx={rx * 1.08} ry={ry * 1.14} fill="#FFFFFF" />;
        })}
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="8 8 84 84">
      <Path d={def.d} fill={botColor[color] ?? botColor.black} />
      {[-1, 1].map((side) => {
        const cx = 50 + side * dx;
        return (
          <G key={side}>
            <Ellipse cx={cx} cy={y} rx={7 * s * k} ry={9 * s * k} fill="#FFFFFF" />
            {pupils && <Circle cx={cx + 1.1 * s} cy={y + 2 * s} r={4 * s} fill="#1C1C1C" />}
            {pupils && <Circle cx={cx + 2.5 * s} cy={y + 0.5 * s} r={1.4 * s} fill="#FFFFFF" />}
          </G>
        );
      })}
    </Svg>
  );
}


/**
 * A bot as it looks now: its picture in the pose that fits what it is doing (when it has poses),
 * its picture, or its shape with eyes that follow its state. `still` shows it at rest.
 */
export function BotAvatar({ bot, size, server, auth, still, crop, radius }: {
  bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'avatarImageUrl'> & Partial<Pick<Bot, 'id' | 'avatarPoses' | 'lastActivityAt'>>; size: number; server?: string; auth?: Record<string, string>; still?: boolean;
  /** 'portrait' shows the head and shoulders, centred on the face, so a full-body character reads at list size. */
  crop?: 'portrait';
  /** Corner radius; a circle when left out. */
  radius?: number;
}) {
  const pose = useBotPose(still ? undefined : bot.id, bot.lastActivityAt);
  const r = radius ?? size / 2;
  if (bot.avatarImageUrl && server) {
    const poses = bot.avatarPoses ?? {};
    const url = (pose && poses[pose]) || poses.idle || bot.avatarImageUrl;
    // Portrait: the server's head-and-shoulders crop, centred on the face (?crop=head).
    const src = crop === 'portrait' ? `${url}${url.includes('?') ? '&' : '?'}crop=head` : url;
    return (
      <View style={{ width: size, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: crop ? PICTURE_GROUND : undefined }}>
        <Image source={{ uri: `${server}${src}`, headers: auth }} fadeDuration={150} style={{ width: size, height: size }} />
      </View>
    );
  }
  if (crop) {
    return (
      <View style={{ width: size, height: size, borderRadius: r, backgroundColor: tint(botColor[bot.avatarColor] ?? botColor.black), alignItems: 'center', justifyContent: 'center' }}>
        <BotShape shape={bot.avatarShape} color={bot.avatarColor} size={size * 0.78} mood={pose} />
      </View>
    );
  }
  return <BotShape shape={bot.avatarShape} color={bot.avatarColor} size={size} mood={pose} />;
}

const PICTURE_GROUND = '#F4EFE9';
/** A very light wash of a bot colour, behind its shape in a tile. */
function tint(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.88);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
