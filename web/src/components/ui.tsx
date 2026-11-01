/* Small design-system primitives. Styling lives in styles.css under the matching class names. */
import { ChevronDown, LoaderCircle, type LucideIcon } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import type { Difficulty } from "../lib/api";

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="currentColor" />
      <path
        d="M12.5 10.5 7.5 16l5 5.5M19.5 10.5l5 5.5-5 5.5"
        stroke="var(--logo-ink)"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function IconButton({
  icon: Icon,
  label,
  active,
  size = 16,
  className,
  ...rest
}: BtnProps & { icon: LucideIcon; label: string; active?: boolean; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={rest.title ?? label}
      className={cx("icon-btn", active && "active", className)}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} />
    </button>
  );
}

export function Button({
  icon: Icon,
  variant = "soft",
  loading,
  children,
  className,
  ...rest
}: BtnProps & { icon?: LucideIcon; variant?: "ghost" | "soft" | "primary" | "accent"; loading?: boolean }) {
  return (
    <button type="button" className={cx("btn", `btn-${variant}`, className)} {...rest}>
      {loading ? <LoaderCircle size={15} className="spin" /> : Icon && <Icon size={15} strokeWidth={1.9} />}
      {children}
    </button>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  badge?: ReactNode;
  dot?: "pass" | "fail" | "accent" | null;
}

/** Tab strip with a single sliding underline. `onActiveClick` fires when the open tab is clicked again. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  onActiveClick,
  className,
  trailing,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  onActiveClick?: () => void;
  className?: string;
  trailing?: ReactNode;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>(`[data-tab="${value}"]`);
    if (!el || !strip.current) return;
    const measure = () => setBar({ x: el.offsetLeft, w: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(strip.current);
    return () => ro.disconnect();
  }, [value, items.length]);

  return (
    <div className={cx("tabs", className)} role="tablist" ref={strip}>
      {items.map(({ id, label, icon: Icon, badge, dot }) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-tab={id}
          aria-selected={value === id}
          className={cx("tab", value === id && "active")}
          onClick={() => (value === id ? onActiveClick?.() : onChange(id))}
        >
          {Icon && <Icon size={15} strokeWidth={1.8} className="tab-icon" />}
          {label}
          {badge != null && badge !== false && <span className="badge">{badge}</span>}
          {dot && <span className={cx("status-dot", dot)} />}
        </button>
      ))}
      {bar && <span className="tab-bar" style={{ transform: `translateX(${bar.x}px)`, width: bar.w }} />}
      {trailing && <div className="tabs-trailing">{trailing}</div>}
    </div>
  );
}

export type Tone = "neutral" | "pass" | "warn" | "fail" | "accent";

export function Chip({
  icon: Icon,
  tone = "neutral",
  children,
  title,
  onClick,
  active,
}: {
  icon?: LucideIcon;
  tone?: Tone;
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const cls = cx("chip", `tone-${tone}`, onClick && "clickable", active && "active");
  const body = (
    <>
      {Icon && <Icon size={13} strokeWidth={1.9} />}
      {children}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} title={title} onClick={onClick} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <span className={cls} title={title}>
      {body}
    </span>
  );
}

export const DIFFICULTY_TONE: Record<Difficulty, Tone> = { intro: "accent", easy: "pass", medium: "warn", hard: "fail" };

export function DifficultyChip({ value }: { value: Difficulty }) {
  return (
    <Chip tone={DIFFICULTY_TONE[value]}>
      <span className="cap">{value}</span>
    </Chip>
  );
}

export function Select({
  icon: Icon,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { icon?: LucideIcon }) {
  return (
    <label className={cx("select", Icon && "with-icon", rest.disabled && "disabled", className)}>
      {Icon && <Icon size={15} strokeWidth={1.8} className="select-icon" />}
      <select {...rest}>{children}</select>
      <ChevronDown size={14} strokeWidth={2} className="select-chevron" />
    </label>
  );
}

export function Skeleton({ w = "100%", h = 14, r }: { w?: number | string; h?: number; r?: number }) {
  return <span className="skeleton" style={{ width: w, height: h, borderRadius: r }} />;
}

export { cx };
