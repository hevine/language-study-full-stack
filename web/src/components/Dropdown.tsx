import {
  CSSProperties,
  ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption<T extends string> {
  value: T;
  label: ReactNode;
  sublabel?: ReactNode;
  icon?: ReactNode;
  /** 右侧固定展示的内容（选中时改为对勾，除非这里也给了内容） */
  trailing?: ReactNode;
  disabled?: boolean;
}

interface DropdownRenderApi<T extends string> {
  open: boolean;
  selected?: DropdownOption<T>;
  toggle: () => void;
}

interface DropdownProps<T extends string = string> {
  value?: T | null;
  onChange?: (value: T) => void;
  /** 声明式选项：自动渲染标准行 + 选中回显 + 键盘导航（与 children 二选一） */
  options?: DropdownOption<T>[];
  /** 自定义菜单内容（优先级高于 options） */
  children?: (api: { close: () => void; selected?: DropdownOption<T> }) => ReactNode;
  /** 自定义触发按钮；不传则渲染内置的 .select-field 触发字段 */
  trigger?: (api: DropdownRenderApi<T>) => ReactNode;
  /** 未选中时触发字段显示的占位文案（仅内置触发字段生效） */
  placeholder?: string;
  /** 触发字段占满整行（仅内置触发字段生效） */
  block?: boolean;
  /** 触发字段附加 class（仅内置触发字段生效） */
  triggerClassName?: string;
  /** 触发字段附加内联样式（仅内置触发字段生效） */
  triggerStyle?: CSSProperties;
  align?: 'start' | 'end';
  /** 菜单宽度贴合触发元素宽度 */
  matchWidth?: boolean;
  /** 菜单额外 class（用于自定义外观，如宽度/内边距） */
  menuClassName?: string;
  /** 包裹层额外 class（如让其在侧栏里占满整行） */
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** 悬浮提示（同时挂到触发字段与菜单） */
  title?: string;
  /** 打开状态变化回调（适合懒加载菜单数据） */
  onOpenChange?: (open: boolean) => void;
  emptyHint?: ReactNode;
}

const MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 手绘对勾：两笔，收尾略上扬 */
function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.9 8.4c1.1.9 1.9 1.9 2.6 3.1 1.6-3.1 3.9-5.9 6.8-8.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 展开箭头：收起/展开时旋转 */
function CaretGlyph() {
  return (
    <svg className="caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Dropdown<T extends string>(props: DropdownProps<T>) {
  const {
    value,
    options,
    children,
    onChange,
    trigger,
    placeholder,
    block = false,
    triggerClassName,
    triggerStyle,
    align = 'start',
    matchWidth = false,
    menuClassName,
    className,
    disabled,
    ariaLabel,
    title,
    onOpenChange,
    emptyHint,
  } = props;

  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const normValue = (value ?? '') as T;
  const selected = options?.find((option) => option.value === normValue);

  const close = useCallback(() => setOpen(false), []);
  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen((current) => {
        if (current === next) return current;
        onOpenChange?.(next);
        return next;
      });
    },
    [onOpenChange],
  );

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpenState(!open);
  }, [disabled, open, setOpenState]);

  const choose = useCallback(
    (val: T) => {
      onChange?.(val);
      setOpen(false);
    },
    [onChange],
  );

  // 计算菜单位置：优先下方，空间不足则翻到上方；左右贴边时夹回视口内
  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    const m = menuRef.current?.getBoundingClientRect();
    if (!t || !m) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = matchWidth ? t.width : Math.max(m.width, t.width);
    let left = align === 'end' ? t.right - width : t.left;
    left = clamp(left, MARGIN, Math.max(MARGIN, vw - width - MARGIN));
    const spaceBelow = vh - t.bottom - MARGIN;
    const spaceAbove = t.top - MARGIN;
    let top: number;
    if (m.height <= spaceBelow || spaceBelow >= spaceAbove) {
      top = t.bottom + MARGIN;
    } else {
      top = t.top - MARGIN - m.height;
    }
    top = Math.max(MARGIN, top);
    setPos({ top, left, width });
  }, [align, matchWidth]);

  // 打开后用 layout 阶段测量并定位，绘制前完成，避免闪烁
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, options, children]);

  // 打开时把焦点移到菜单，键盘导航才可生效
  useEffect(() => {
    if (open) menuRef.current?.focus({ preventScroll: true });
  }, [open, pos]);

  // 打开时把选中项滚入可视区（回显）
  useEffect(() => {
    if (!open || !selected) return;
    menuRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selected]);

  // 外部点击 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 滚动 / 窗口缩放时重新贴合触发元素
  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  // 打开时把键盘高亮初始化到选中项
  useEffect(() => {
    if (open && options) {
      setActiveIndex(options.findIndex((option) => option.value === normValue));
    }
  }, [open, options, normValue]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (!options || options.length === 0) return;
    const enabled = options
      .map((option, index) => ({ option, index }))
      .filter((entry) => !entry.option.disabled);
    if (enabled.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = enabled.findIndex((entry) => entry.index === activeIndex);
      let next = current;
      if (event.key === 'ArrowDown') {
        next = current < 0 ? 0 : (current + 1) % enabled.length;
      } else {
        next = current <= 0 ? enabled.length - 1 : current - 1;
      }
      const target = enabled[next];
      setActiveIndex(target.index);
      menuRef.current
        ?.querySelector(`[data-index="${target.index}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(enabled[0].index);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(enabled[enabled.length - 1].index);
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0 && options[activeIndex] && !options[activeIndex].disabled) {
        event.preventDefault();
        choose(options[activeIndex].value);
      }
    }
  };

  const defaultTrigger = (
    <button
      type="button"
      className={`select-field${block ? ' block' : ''}${open ? ' open' : ''}${
        triggerClassName ? ` ${triggerClassName}` : ''
      }`}
      style={triggerStyle}
      onClick={toggle}
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open}
    >
      <span className="sf-label">{selected?.label ?? placeholder ?? '请选择…'}</span>
      <CaretGlyph />
    </button>
  );

  return (
    <span
      className={`wb-dropdown${className ? ` ${className}` : ''}`}
      ref={triggerRef}
      title={title}
    >
      {trigger ? trigger({ open, selected, toggle }) : defaultTrigger}
      {open
        ? createPortal(
            <div
              ref={menuRef}
              tabIndex={-1}
              role="listbox"
              aria-label={ariaLabel}
              className={`wb-dropdown-menu${menuClassName ? ` ${menuClassName}` : ''}`}
              style={{
                top: pos ? pos.top : -9999,
                left: pos ? pos.left : -9999,
                width: pos ? pos.width : undefined,
                visibility: pos ? 'visible' : 'hidden',
                maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
              }}
              onKeyDown={onMenuKeyDown}
            >
              {children ? (
                children({ close, selected })
              ) : (
                <div className="wb-dropdown-list">
                  {options && options.length > 0 ? (
                    options.map((option, index) => {
                      const isSel = option.value === normValue;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          data-index={index}
                          data-selected={isSel}
                          role="option"
                          aria-selected={isSel}
                          disabled={option.disabled}
                          className={`wb-dropdown-item${isSel ? ' active' : ''}${
                            index === activeIndex ? ' kbd' : ''
                          }`}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => choose(option.value)}
                        >
                          {option.icon ? (
                            <span className="wb-dropdown-ic">{option.icon}</span>
                          ) : null}
                          <span className="wb-dropdown-body">
                            <span className="wb-dropdown-label">{option.label}</span>
                            {option.sublabel ? (
                              <span className="wb-dropdown-sub">{option.sublabel}</span>
                            ) : null}
                          </span>
                          <span className="wb-dropdown-trail">
                            {isSel ? <CheckGlyph /> : option.trailing}
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="wb-dropdown-empty">{emptyHint ?? '暂无选项'}</div>
                  )}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
