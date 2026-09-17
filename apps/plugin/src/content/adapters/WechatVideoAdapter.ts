import { BasePlatformAdapter, DomLike, FillPayload, FillReport } from '../BasePlatformAdapter';

/** channels.weixin.qq.com — fills the post editor; the operator confirms the publish. */
export class WechatVideoAdapter extends BasePlatformAdapter {
  readonly platform = 'wechat_video';
  readonly matches = ['channels.weixin.qq.com'];

  fill(document: DomLike, payload: FillPayload): FillReport {
    const report: FillReport = { filled: [], missing: [] };

    const description =
      this.findByPlaceholder(document, ['添加描述', '描述', '说点什么']) ??
      this.findEditable(document, ['textarea', 'div[contenteditable="true"]']);
    const body = payload.tags.length > 0 ? `${payload.body}\n\n${payload.tags.map((tag) => `#${tag}`).join(' ')}` : payload.body;
    this.setValue(description, body, report, 'description');

    const titleInput = this.findByPlaceholder(document, ['标题']) ?? this.findEditable(document, ['input[placeholder*="标题"]']);
    this.setValue(titleInput, payload.title.slice(0, 16), report, 'title');

    return report;
  }
}
