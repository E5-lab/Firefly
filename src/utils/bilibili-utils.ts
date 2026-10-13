import type { StandardizedAnime } from "@/types/bilibili";

export interface BilibiliItem {
	media_id: number;
	title: string;
	cover?: string;
	season_type?: number;
	season_type_name?: string;
	rating?: { score?: number };
	evaluate?: string;
	brief?: string;
	season_id: number;
	new_ep?: { index_show?: string };
}

const BILIBILI_API = "https://api.bilibili.com/x/space/bangumi/follow/list";
const PAGE_SIZE = 30;

// 构建机（尤其是海外机房）访问 B 站接口可能长时间无响应，
// 旧实现没有任何超时控制，会把整次静态构建一起拖到超时失败。
// 这里给每个请求加硬超时，并在任何异常时降级为空数据，保证构建永远不受影响。
const REQUEST_TIMEOUT_MS = 10000;

/** 带超时、永不抛错、永不挂起的 JSON 请求；失败时返回 null */
async function fetchJsonSafe(url: string): Promise<any | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			console.warn(`[Bilibili] HTTP ${res.status} for ${url}`);
			return null;
		}
		return await res.json();
	} catch (error) {
		console.warn(
			`[Bilibili] Request failed (${url}): ${(error as Error)?.message ?? error}`,
		);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 获取指定类型的全部追番数据（任何失败都返回空数组，不影响构建） */
async function fetchBilibiliByType(
	uid: string,
	type: number,
): Promise<BilibiliItem[]> {
	const items: BilibiliItem[] = [];

	// 第一页，获取 total
	const firstJson = await fetchJsonSafe(
		`${BILIBILI_API}?type=${type}&vmid=${uid}&pn=1&ps=${PAGE_SIZE}`,
	);
	if (!firstJson || firstJson.code !== 0 || !firstJson.data?.list?.length) {
		return items;
	}

	items.push(...firstJson.data.list);
	const total = firstJson.data.total || items.length;
	const totalPages = Math.ceil(total / PAGE_SIZE);

	// 并发请求剩余页
	if (totalPages > 1) {
		const promises: Promise<BilibiliItem[]>[] = [];
		for (let pn = 2; pn <= totalPages; pn++) {
			promises.push(
				fetchJsonSafe(
					`${BILIBILI_API}?type=${type}&vmid=${uid}&pn=${pn}&ps=${PAGE_SIZE}`,
				).then((j) => j?.data?.list || []),
			);
		}
		const remaining = await Promise.all(promises);
		for (const batch of remaining) {
			items.push(...batch);
		}
	}
	return items;
}

/** 获取 Bilibili 追番（type=1）+ 追剧（type=2）并标准化 */
export async function fetchBilibiliList(
	uid: string,
): Promise<StandardizedAnime[]> {
	const [animeItems, dramaItems] = await Promise.all([
		fetchBilibiliByType(uid, 1),
		fetchBilibiliByType(uid, 2),
	]);
	console.log(
		`[Bilibili] Fetched ${animeItems.length + dramaItems.length} items (anime: ${animeItems.length}, drama: ${dramaItems.length}).`,
	);

	return [...animeItems, ...dramaItems].map((item) => ({
		id: item.media_id,
		title: item.title,
		originalTitle: item.title,
		poster: item.cover ? item.cover.replace("http://", "https://") : null,
		// season_type: 1=番剧, 2=电影, 3=纪录片, 4=国创, 5=电视剧
		type: item.season_type === 2 ? ("movie" as const) : ("tv" as const),
		season_type: item.season_type || 1,
		rating: item.rating?.score || 0,
		date: "",
		overview: item.evaluate || item.brief || "",
		link: `https://www.bilibili.com/bangumi/play/ss${item.season_id}`,
		epStatus: item.new_ep?.index_show || "",
	}));
}
