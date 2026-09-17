import { BasePlatformAdapter, DomLike, FillPayload, FillReport } from '../BasePlatformAdapter';

/** creator.xiaohongshu.com — fills the note editor, the operator presses 发布. */
export class XiaohongshuAdapter extends BasePlatformAdapter {
  readonly platform = 'xiaohongshu';
  readonly matches = ['creator.xiaohongshu.com', 'www.xiaohongshu.com/publish'];

  fill(document: DomLike, payload: FillPayload): FillReport {
    const report: FillReport = { filled: [], missing: [] };

    const titleInput = this.findByPlaceholder(document, ['填写标题', '标题']) ?? this.findEditable(document, ['input[placeholder*="标题"]']);
    this.setValue(titleInput, payload.title.slice(0, 20), report, 'title');

    const bodyEditor =
      this.findByPlaceholder(document, ['输入正文', '正文描述', '写点什么']) ??
      this.findEditable(document, ['div[contenteditable="true"]', 'textarea[placeholder*="正文"]']);
    const body = payload.tags.length > 0 ? `${payload.body}\n\n${payload.tags.map((tag) => `#${tag}`).join(' ')}` : payload.body;
    this.setValue(bodyEditor, body, report, 'body');

    return report;
  }
}
