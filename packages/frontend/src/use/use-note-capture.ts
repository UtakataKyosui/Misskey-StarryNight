/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onUnmounted } from 'vue';
import * as Misskey from 'misskey-js';
import { EventEmitter } from 'eventemitter3';
import type { Ref, ShallowRef } from 'vue';
import { useStream } from '@/stream.js';
import { $i } from '@/i.js';
import { store } from '@/store.js';
import { misskeyApi } from '@/utility/misskey-api.js';

const noteEvents = new EventEmitter<{
	reacted: Misskey.entities.Note;
	unreacted: Misskey.entities.Note;
	pollVoted: Misskey.entities.Note;
	deleted: Misskey.entities.Note;
}>();

const fetchEvent = new EventEmitter<{
	[id: string]: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis'>;
}>();

const capturedNoteIdMapForPolling = new Map<string, number>();

const CAPTURE_MAX = 30;
const POLLING_INTERVAL = 1000 * 15;

window.setInterval(() => {
	const ids = [...capturedNoteIdMapForPolling.keys()].sort((a, b) => (a > b ? -1 : 1)).slice(0, CAPTURE_MAX); // 新しいものを優先するためにIDで降順ソート
	if (ids.length === 0) return;
	if (window.document.hidden) return;

	// まとめてリクエストするのではなく、個別にHTTPリクエスト投げてCDNにキャッシュさせた方がサーバーの負荷低減には良いかもしれない
	misskeyApi('notes/show-partial-bulk', {
		noteIds: ids,
	}).then((items) => {
		for (const item of items) {
			fetchEvent.emit(item.id, {
				reactions: item.reactions,
				reactionEmojis: item.reactionEmojis,
			});
		}
	});
}, POLLING_INTERVAL);

function pseudoNoteCapture(props: {
	rootEl: ShallowRef<HTMLElement | undefined>;
	note: Ref<Misskey.entities.Note>;
	pureNote: Ref<Misskey.entities.Note>;
	isDeletedRef: Ref<boolean>;
}) {
	const note = props.note;
	const pureNote = props.pureNote;

	function onReacted(): void {

	}

	function onFetched(data: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis'>): void {
		note.value.reactions = data.reactions;
		note.value.reactionCount = Object.values(data.reactions).reduce((a, b) => a + b, 0);
		note.value.reactionEmojis = data.reactionEmojis;
	}

	if (capturedNoteIdMapForPolling.has(note.value.id)) {
		capturedNoteIdMapForPolling.set(note.value.id, capturedNoteIdMapForPolling.get(note.value.id)! + 1);
	} else {
		capturedNoteIdMapForPolling.set(note.value.id, 1);
	}

	fetchEvent.on(note.value.id, onFetched);

	onUnmounted(() => {
		capturedNoteIdMapForPolling.set(note.value.id, capturedNoteIdMapForPolling.get(note.value.id)! - 1);
		if (capturedNoteIdMapForPolling.get(note.value.id) === 0) {
			capturedNoteIdMapForPolling.delete(note.value.id);
		}

		fetchEvent.off(note.value.id, onFetched);
	});
}

function realtimeNoteCapture(props: {
	rootEl: ShallowRef<HTMLElement | undefined>;
	note: Ref<Misskey.entities.Note>;
	pureNote: Ref<Misskey.entities.Note>;
	isDeletedRef: Ref<boolean>;
}): void {
	const note = props.note;
	const pureNote = props.pureNote;
	const connection = useStream();

	function onStreamNoteUpdated(noteData): void {
		const { type, id, body } = noteData;

		if ((id !== note.value.id) && (id !== pureNote.value.id)) return;

		switch (type) {
			case 'reacted': {
				const reaction = body.reaction;

				if (body.emoji && !(body.emoji.name in note.value.reactionEmojis)) {
					note.value.reactionEmojis[body.emoji.name] = body.emoji.url;
				}

				// TODO: reactionsプロパティがない場合ってあったっけ？ なければ || {} は消せる
				const currentCount = (note.value.reactions || {})[reaction] || 0;

				note.value.reactions[reaction] = currentCount + 1;
				note.value.reactionCount += 1;

				if ($i && (body.userId === $i.id)) {
					note.value.myReaction = reaction;
				}
				break;
			}

			case 'unreacted': {
				const reaction = body.reaction;

				// TODO: reactionsプロパティがない場合ってあったっけ？ なければ || {} は消せる
				const currentCount = (note.value.reactions || {})[reaction] || 0;

				note.value.reactions[reaction] = Math.max(0, currentCount - 1);
				note.value.reactionCount = Math.max(0, note.value.reactionCount - 1);
				if (note.value.reactions[reaction] === 0) delete note.value.reactions[reaction];

				if ($i && (body.userId === $i.id)) {
					note.value.myReaction = null;
				}
				break;
			}

			case 'pollVoted': {
				const choice = body.choice;

				const choices = [...note.value.poll.choices];
				choices[choice] = {
					...choices[choice],
					votes: choices[choice].votes + 1,
					...($i && (body.userId === $i.id) ? {
						isVoted: true,
					} : {}),
				};

				note.value.poll.choices = choices;
				break;
			}

			case 'deleted': {
				props.isDeletedRef.value = true;
				break;
			}
		}
	}

	function capture(withHandler = false): void {
		// TODO: このノートがストリーミング経由で流れてきた場合のみ sr する
		connection.send(window.document.body.contains(props.rootEl.value ?? null as Node | null) ? 'sr' : 's', { id: note.value.id });
		if (pureNote.value.id !== note.value.id) connection.send('s', { id: pureNote.value.id });
		if (withHandler) connection.on('noteUpdated', onStreamNoteUpdated);
	}

	function decapture(withHandler = false): void {
		connection.send('un', {
			id: note.value.id,
		});
		if (pureNote.value.id !== note.value.id) {
			connection.send('un', {
				id: pureNote.value.id,
			});
		}
		if (withHandler) connection.off('noteUpdated', onStreamNoteUpdated);
	}

	function onStreamConnected() {
		capture(false);
	}

	capture(true);
	connection.on('_connected_', onStreamConnected);

	onUnmounted(() => {
		decapture(true);
		connection.off('_connected_', onStreamConnected);
	});
}

export function useNoteCapture(props: {
	rootEl: ShallowRef<HTMLElement | undefined>;
	note: Ref<Misskey.entities.Note>;
	pureNote: Ref<Misskey.entities.Note>;
	isDeletedRef: Ref<boolean>;
}) {
	if ($i && store.s.realtimeMode) {
		realtimeNoteCapture(props);
	} else {
		pseudoNoteCapture(props);
	}
}
