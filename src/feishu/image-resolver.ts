import { logger } from "../utils/logger.js";
import type { FeishuClients } from "./client.js";

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const HTTP_URL_RE = /^https?:\/\//i;

export interface ImageResolverOptions {
	client: FeishuClients["client"];
	onImageResolved?: () => void;
}

export class ImageResolver {
	private readonly resolved = new Map<string, string>();
	private readonly pending = new Map<string, Promise<string | null>>();
	private readonly failed = new Set<string>();
	private readonly client: FeishuClients["client"];
	private readonly onImageResolved: () => void;

	constructor(options: ImageResolverOptions) {
		this.client = options.client;
		this.onImageResolved = options.onImageResolved ?? (() => undefined);
	}

	resolveImages(text: string): string {
		if (!text.includes("![")) {
			return text;
		}

		return text.replace(IMAGE_RE, (fullMatch, alt: string, value: string) => {
			if (value.startsWith("img_")) {
				return fullMatch;
			}

			if (!HTTP_URL_RE.test(value)) {
				return "";
			}

			const cachedKey = this.resolved.get(value);
			if (cachedKey) {
				return `![${alt}](${cachedKey})`;
			}

			if (this.failed.has(value)) {
				return "";
			}

			if (this.pending.has(value)) {
				return "";
			}

			this.startUpload(value);
			return "";
		});
	}

	async resolveImagesAwait(
		text: string,
		timeoutMs: number = 15_000,
	): Promise<string> {
		const remoteUrls = this.collectRemoteUrls(text);
		this.resolveImages(text);

		const pendingUploads = remoteUrls
			.map((url) => this.pending.get(url))
			.filter(
				(upload): upload is Promise<string | null> => upload !== undefined,
			);

		if (pendingUploads.length > 0) {
			const didTimeout = await Promise.race([
				Promise.allSettled(pendingUploads).then(() => false),
				new Promise<boolean>((resolve) => {
					setTimeout(() => resolve(true), timeoutMs);
				}),
			]);

			if (didTimeout) {
				logger.warn(
					`[ImageResolver] Timed out waiting for image uploads; remaining=${this.pending.size}`,
				);
			}
		}

		return this.resolveImages(text);
	}

	private collectRemoteUrls(text: string): string[] {
		if (!text.includes("![")) {
			return [];
		}

		const urls = new Set<string>();
		for (const match of text.matchAll(IMAGE_RE)) {
			const value = match[2];
			if (value && HTTP_URL_RE.test(value)) {
				urls.add(value);
			}
		}

		return [...urls];
	}

	private startUpload(url: string): void {
		if (
			this.resolved.has(url) ||
			this.pending.has(url) ||
			this.failed.has(url)
		) {
			return;
		}

		const uploadPromise = this.doUpload(url);
		this.pending.set(url, uploadPromise);
	}

	private async doUpload(url: string): Promise<string | null> {
		try {
			const imageBuffer = await this.downloadImage(url);
			const response = await this.client.im.image.create({
				data: {
					image_type: "message",
					image: imageBuffer,
				},
			});

			const imageKey = response?.image_key;
			if (!imageKey) {
				throw new Error("Feishu image upload returned no image_key");
			}

			this.resolved.set(url, imageKey);
			this.onImageResolved();
			return imageKey;
		} catch (error) {
			this.failed.add(url);
			logger.warn(`[ImageResolver] Failed to resolve image: ${url}`, error);
			return null;
		} finally {
			this.pending.delete(url);
		}
	}

	private async downloadImage(url: string): Promise<Buffer> {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Image download failed with status ${response.status}`);
		}

		const imageBuffer = Buffer.from(await response.arrayBuffer());
		if (imageBuffer.length === 0) {
			throw new Error("Image download returned an empty body");
		}

		return imageBuffer;
	}
}
