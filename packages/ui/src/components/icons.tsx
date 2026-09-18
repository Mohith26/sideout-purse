import {
  Activity,
  ArrowRight,
  Ban,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  ExternalLink,
  Flag,
  Gift,
  GitBranch,
  HandCoins,
  HeartHandshake,
  Hourglass,
  House,
  Info,
  LayoutDashboard,
  LayoutGrid,
  Locate,
  Lock,
  LogOut,
  MapPin,
  Maximize,
  Medal,
  Minus,
  Phone,
  Plus,
  Radio,
  ShieldCheck,
  Shuffle,
  Table2,
  Trash2,
  TriangleAlert,
  Trophy,
  User,
  Users,
  Wallet,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
  type LucideProps,
} from 'lucide-react';
import { createElement, type ComponentType } from 'react';

/**
 * The single icon set (spec 7: one set, 1.5px stroke). Every consumer imports from here
 * so the stroke weight and the size default are set once; nothing imports lucide-react
 * directly, and an icon is decorative by default (`aria-hidden`), named by the control
 * or label beside it.
 */
export type IconProps = LucideProps;
export type IconComponent = ComponentType<IconProps>;

function withDefaults(Icon: IconComponent): IconComponent {
  const Wrapped: IconComponent = (props) => createElement(Icon, { strokeWidth: 1.5, size: 18, 'aria-hidden': true, focusable: false, ...props });
  Wrapped.displayName = `Icon(${Icon.displayName ?? 'Icon'})`;
  return Wrapped;
}

export const Icons = {
  activity: withDefaults(Activity),
  arrowRight: withDefaults(ArrowRight),
  ban: withDefaults(Ban),
  bracket: withDefaults(GitBranch),
  calendar: withDefaults(Calendar),
  check: withDefaults(Check),
  chevronDown: withDefaults(ChevronDown),
  chevronLeft: withDefaults(ChevronLeft),
  chevronRight: withDefaults(ChevronRight),
  circleAlert: withDefaults(CircleAlert),
  circleCheck: withDefaults(CircleCheck),
  circleDashed: withDefaults(CircleDashed),
  clock: withDefaults(Clock),
  console: withDefaults(LayoutDashboard),
  externalLink: withDefaults(ExternalLink),
  flag: withDefaults(Flag),
  gift: withDefaults(Gift),
  grid: withDefaults(LayoutGrid),
  handCoins: withDefaults(HandCoins),
  heartHandshake: withDefaults(HeartHandshake),
  home: withDefaults(House),
  hourglass: withDefaults(Hourglass),
  info: withDefaults(Info),
  locate: withDefaults(Locate),
  lock: withDefaults(Lock),
  logOut: withDefaults(LogOut),
  mapPin: withDefaults(MapPin),
  maximize: withDefaults(Maximize),
  medal: withDefaults(Medal),
  minus: withDefaults(Minus),
  phone: withDefaults(Phone),
  plus: withDefaults(Plus),
  radio: withDefaults(Radio),
  shieldCheck: withDefaults(ShieldCheck),
  shuffle: withDefaults(Shuffle),
  table: withDefaults(Table2),
  trash: withDefaults(Trash2),
  triangleAlert: withDefaults(TriangleAlert),
  trophy: withDefaults(Trophy),
  user: withDefaults(User),
  users: withDefaults(Users),
  wallet: withDefaults(Wallet),
  wifiOff: withDefaults(WifiOff),
  x: withDefaults(X),
  zoomIn: withDefaults(ZoomIn),
  zoomOut: withDefaults(ZoomOut),
} as const satisfies Record<string, IconComponent>;

export type IconName = keyof typeof Icons;
