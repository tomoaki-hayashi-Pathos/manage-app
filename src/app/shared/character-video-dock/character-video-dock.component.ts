import {
    AfterViewInit,
    Component,
    ElementRef,
    EventEmitter,
    HostBinding,
    HostListener,
    Input,
    OnChanges,
    OnDestroy,
    Output,
    SimpleChanges,
    ViewChild,
    inject
} from '@angular/core';
import { StorageService, storageKeyCharacterDockPosition } from '../../services/storage.service';

type DockPosition = { left: number; top: number };

const DRAG_THRESHOLD_PX = 6;

@Component({
    selector: 'app-character-video-dock',
    standalone: true,
    templateUrl: './character-video-dock.component.html',
    styleUrls: ['./character-video-dock.component.css'],
    host: {
        class: 'character-video-dock character-video-dock--fixed-br character-video-dock--bubble-above character-video-dock--draggable',
        'aria-live': 'polite'
    }
})
export class CharacterVideoDockComponent implements OnChanges, OnDestroy, AfterViewInit {
    private readonly storage = inject(StorageService);
    private readonly hostEl = inject(ElementRef<HTMLElement>);

    @ViewChild('dockVideo') private dockVideoRef?: ElementRef<HTMLVideoElement>;

    @Input({ required: true }) dockScope!: 'admin' | 'member';
    @Input() userUid = '';
    @Input() videoSrc = '/assets/character-typing.mp4';
    @Input() bubbleOpen = false;
    @Input() bubbleText = '';
    @Input() showConfirmButton = false;
    @Input() underDrawer = false;

    @Output() readonly videoClick = new EventEmitter<void>();
    @Output() readonly confirmClick = new EventEmitter<void>();
    @Output() readonly dockPointerEnter = new EventEmitter<void>();
    @Output() readonly dockPointerLeave = new EventEmitter<void>();

    @HostBinding('class.character-video-dock--under-drawer')
    get hostUnderDrawer(): boolean {
        return this.underDrawer;
    }

    @HostBinding('class.character-video-dock--custom-pos')
    useCustomPos = false;

    @HostBinding('class.character-video-dock--dragging')
    dragging = false;

    @HostBinding('style.left.px')
    posLeft: number | null = null;

    @HostBinding('style.top.px')
    posTop: number | null = null;

    private dragOffsetX = 0;
    private dragOffsetY = 0;

    private activePointerId: number | null = null;
    private pointerDownX = 0;
    private pointerDownY = 0;
    private fromVideoArea = false;

    private readonly onDocPointerMove = (ev: PointerEvent) => this.onDocumentPointerMove(ev);
    private readonly onDocPointerUp = (ev: PointerEvent) => this.onDocumentPointerUp(ev);

    ngAfterViewInit(): void {
        this.tryPlayVideo();
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['userUid'] || changes['dockScope']) {
            this.loadSavedPosition();
        }
        if (changes['videoSrc'] && !changes['videoSrc'].firstChange) {
            queueMicrotask(() => this.tryPlayVideo());
        }
    }

    ngOnDestroy(): void {
        this.finishPointerSession();
    }

    @HostListener('mouseenter')
    onHostMouseEnter(): void {
        this.dockPointerEnter.emit();
    }

    @HostListener('mouseleave')
    onHostMouseLeave(): void {
        if (!this.dragging && this.activePointerId === null) {
            this.dockPointerLeave.emit();
        }
    }

    @HostListener('pointerdown', ['$event'])
    onHostPointerDown(ev: PointerEvent): void {
        if (ev.button !== 0) return;
        if (this.isNonDragTarget(ev.target)) return;

        const onVideo = !!((ev.target as HTMLElement).closest('.character-video-dock__media'));
        this.fromVideoArea = onVideo;
        this.dockPointerEnter.emit();
        this.startPointerSession(ev);

        if (!onVideo) {
            ev.preventDefault();
            this.beginDrag(ev.clientX, ev.clientY);
        }
    }

    onChatPointerDown(ev: PointerEvent): void {
        ev.stopPropagation();
    }

    onChatClick(ev: MouseEvent): void {
        ev.stopPropagation();
        this.videoClick.emit();
    }

    onVideoReady(): void {
        this.tryPlayVideo();
    }

    onConfirmClick(ev: Event): void {
        ev.stopPropagation();
        this.confirmClick.emit();
    }

    private tryPlayVideo(): void {
        const video = this.dockVideoRef?.nativeElement;
        if (!video) return;
        video.muted = true;
        const playPromise = video.play();
        if (playPromise) {
            void playPromise.catch(() => undefined);
        }
    }

    private isNonDragTarget(target: EventTarget | null): boolean {
        const el = target as HTMLElement | null;
        if (!el) return true;
        if (el.closest('.character-video-dock__chat-btn')) return true;
        if (el.closest('.character-video-bubble__confirm')) return true;
        return false;
    }

    private startPointerSession(ev: PointerEvent): void {
        this.finishPointerSession(false);
        this.activePointerId = ev.pointerId;
        this.pointerDownX = ev.clientX;
        this.pointerDownY = ev.clientY;
        try {
            this.hostEl.nativeElement.setPointerCapture(ev.pointerId);
        } catch {
            /* 未対応環境は document リスナーのみ */
        }
        document.addEventListener('pointermove', this.onDocPointerMove);
        document.addEventListener('pointerup', this.onDocPointerUp);
        document.addEventListener('pointercancel', this.onDocPointerUp);
    }

    private onDocumentPointerMove(ev: PointerEvent): void {
        if (ev.pointerId !== this.activePointerId) return;

        if (!this.dragging) {
            if (this.fromVideoArea) {
                const dx = ev.clientX - this.pointerDownX;
                const dy = ev.clientY - this.pointerDownY;
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            }
            this.beginDrag(ev.clientX, ev.clientY);
            return;
        }

        this.onDragMove(ev.clientX, ev.clientY);
    }

    private onDocumentPointerUp(ev: PointerEvent): void {
        if (ev.pointerId !== this.activePointerId) return;
        if (this.dragging) {
            this.endDrag();
        }
        this.finishPointerSession();
        if (!this.isPointerOverHost(ev.clientX, ev.clientY)) {
            this.dockPointerLeave.emit();
        }
    }

    private finishPointerSession(releaseCapture = true): void {
        document.removeEventListener('pointermove', this.onDocPointerMove);
        document.removeEventListener('pointerup', this.onDocPointerUp);
        document.removeEventListener('pointercancel', this.onDocPointerUp);
        if (releaseCapture && this.activePointerId !== null) {
            try {
                this.hostEl.nativeElement.releasePointerCapture(this.activePointerId);
            } catch {
                /* noop */
            }
        }
        this.activePointerId = null;
        this.fromVideoArea = false;
    }

    private loadSavedPosition(): void {
        const uid = this.userUid?.trim();
        if (!uid) {
            this.clearCustomPosition();
            return;
        }
        const saved = this.storage.getJson<DockPosition | null>(storageKeyCharacterDockPosition(this.dockScope, uid));
        if (
            saved &&
            typeof saved.left === 'number' &&
            typeof saved.top === 'number' &&
            Number.isFinite(saved.left) &&
            Number.isFinite(saved.top)
        ) {
            const clamped = this.clampPosition(saved.left, saved.top);
            this.posLeft = clamped.left;
            this.posTop = clamped.top;
            this.useCustomPos = true;
            return;
        }
        this.clearCustomPosition();
    }

    private clearCustomPosition(): void {
        this.useCustomPos = false;
        this.posLeft = null;
        this.posTop = null;
    }

    private beginDrag(clientX: number, clientY: number): void {
        if (this.dragging) return;
        this.ensureCustomPosition(clientX, clientY);
        this.dragging = true;
        this.dragOffsetX = clientX - (this.posLeft ?? 0);
        this.dragOffsetY = clientY - (this.posTop ?? 0);
    }

    private ensureCustomPosition(clientX: number, clientY: number): void {
        if (this.useCustomPos && this.posLeft !== null && this.posTop !== null) return;
        const rect = this.hostEl.nativeElement.getBoundingClientRect();
        const clamped = this.clampPosition(rect.left, rect.top);
        this.posLeft = clamped.left;
        this.posTop = clamped.top;
        this.useCustomPos = true;
        this.dragOffsetX = clientX - this.posLeft;
        this.dragOffsetY = clientY - this.posTop;
    }

    private onDragMove(clientX: number, clientY: number): void {
        if (!this.dragging) return;
        const clamped = this.clampPosition(clientX - this.dragOffsetX, clientY - this.dragOffsetY);
        this.posLeft = clamped.left;
        this.posTop = clamped.top;
        this.useCustomPos = true;
    }

    private endDrag(): void {
        if (!this.dragging) return;
        this.dragging = false;
        this.persistPosition();
    }

    private clampPosition(left: number, top: number): { left: number; top: number } {
        const el = this.hostEl.nativeElement;
        const w = el.offsetWidth || 48;
        const h = el.offsetHeight || 48;
        const margin = 8;
        const maxLeft = Math.max(margin, window.innerWidth - w - margin);
        const maxTop = Math.max(margin, window.innerHeight - h - margin);
        return {
            left: Math.min(Math.max(margin, left), maxLeft),
            top: Math.min(Math.max(margin, top), maxTop)
        };
    }

    private isPointerOverHost(clientX: number, clientY: number): boolean {
        const r = this.hostEl.nativeElement.getBoundingClientRect();
        return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    }

    private persistPosition(): void {
        const uid = this.userUid?.trim();
        if (!uid || !this.useCustomPos || this.posLeft === null || this.posTop === null) return;
        this.storage.setJson(storageKeyCharacterDockPosition(this.dockScope, uid), {
            left: this.posLeft,
            top: this.posTop
        });
    }
}
