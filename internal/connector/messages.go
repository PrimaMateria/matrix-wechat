package connector

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/url"
	"strconv"
	"strings"

	"github.com/gabriel-vasile/mimetype"
	"github.com/yamada-sexta/matrix-wechat/pkg/backend"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/format"
)

func matrixType(kind backend.Kind) event.MessageType {
	switch kind {
	case backend.Image, backend.Sticker:
		return event.MsgImage
	case backend.Video:
		return event.MsgVideo
	case backend.Audio:
		return event.MsgAudio
	case backend.File:
		return event.MsgFile
	case backend.LocationMessage:
		return event.MsgLocation
	case backend.Notice:
		return event.MsgNotice
	default:
		return event.MsgText
	}
}
func validURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (strings.EqualFold(u.Scheme, "https") || strings.EqualFold(u.Scheme, "http")) && u.Host != "" && u.User == nil
}

// Rich cards always have a useful plain-text fallback. Hook content is escaped,
// never interpreted as Markdown/HTML, and only http(s) URLs become active links.
func cardContent(card *backend.Card) *event.MessageEventContent {
	content := &event.MessageEventContent{MsgType: event.MsgText}
	if card == nil {
		content.Body = "Unsupported WeChat card"
		return content
	}
	var plain, formatted []string
	if card.Title != "" {
		plain = append(plain, card.Title)
		title := html.EscapeString(card.Title)
		if validURL(card.URL) {
			title = `<a href="` + html.EscapeString(card.URL) + `">` + title + `</a>`
		}
		formatted = append(formatted, "<strong>"+title+"</strong>")
	}
	if card.Description != "" {
		plain = append(plain, card.Description)
		formatted = append(formatted, strings.ReplaceAll(html.EscapeString(card.Description), "\n", "<br>"))
	}
	if card.Source != "" {
		plain = append(plain, card.Source)
		formatted = append(formatted, "<em>"+html.EscapeString(card.Source)+"</em>")
	}
	if card.URL != "" {
		plain = append(plain, card.URL)
		link := html.EscapeString(card.URL)
		if validURL(card.URL) {
			link = `<a href="` + link + `">` + link + `</a>`
		}
		formatted = append(formatted, link)
	}
	content.Body = strings.Join(plain, "\n")
	if content.Body == "" {
		content.Body = "WeChat shared card"
	}
	content.Format = event.FormatHTML
	content.FormattedBody = strings.Join(formatted, "<br>")
	if validURL(card.URL) {
		content.BeeperLinkPreviews = []*event.BeeperLinkPreview{{MatchedURL: card.URL, LinkPreview: event.LinkPreview{CanonicalURL: card.URL, Title: card.Title, Description: card.Description, SiteName: card.Source}}}
	}
	return content
}
func (c *Client) readMedia(ctx context.Context, media backend.Media) ([]byte, error) {
	limit := c.connector.Config.MaxMediaSize
	if media.Size > limit || int64(len(media.Data)) > limit {
		return nil, errors.New("WeChat attachment exceeds network.max_media_size")
	}
	reader, err := c.session.OpenMedia(ctx, media)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("WeChat attachment exceeds network.max_media_size")
	}
	return data, nil
}
func (c *Client) convertIncoming(ctx context.Context, portal *bridgev2.Portal, intent bridgev2.MatrixAPI, evt backend.Event) (*bridgev2.ConvertedMessage, error) {
	msg := evt.Message
	converted := &bridgev2.ConvertedMessage{}
	if msg.ReplyTo != "" {
		converted.ReplyTo = &networkid.MessageOptionalPartID{MessageID: messageID(evt.ChatID, msg.ReplyTo)}
	}
	content := &event.MessageEventContent{MsgType: matrixType(msg.Kind), Body: replacer.Replace(msg.Text)}
	typ := event.EventMessage
	switch msg.Kind {
	case backend.CardMessage:
		content = cardContent(msg.Card)
		if msg.Card != nil && msg.Card.Thumbnail != nil && len(content.BeeperLinkPreviews) > 0 {
			media := *msg.Card.Thumbnail
			data, err := c.readMedia(ctx, media)
			if err == nil {
				mime := mimetype.Detect(data).String()
				if strings.HasPrefix(mime, "image/") {
					uri, file, err := intent.UploadMedia(ctx, portal.MXID, data, media.Name, mime)
					if err == nil {
						preview := content.BeeperLinkPreviews[0]
						preview.ImageURL = uri
						preview.ImageEncryption = file
						preview.ImageType = mime
						preview.ImageSize = event.IntOrString(len(data))
						preview.ImageWidth = event.IntOrString(media.Width)
						preview.ImageHeight = event.IntOrString(media.Height)
					}
				}
			}
			// A missing optional thumbnail must not lose the article/link itself.
		}
	case backend.LocationMessage:
		l := msg.Location
		if l == nil || math.IsNaN(l.Latitude) || math.IsNaN(l.Longitude) || math.IsInf(l.Latitude, 0) || math.IsInf(l.Longitude, 0) || l.Latitude < -90 || l.Latitude > 90 || l.Longitude < -180 || l.Longitude > 180 {
			return nil, errors.New("invalid WeChat location")
		}
		content.Body = strings.TrimSpace(l.Name + "\n" + l.Address)
		content.GeoURI = fmt.Sprintf("geo:%g,%g", l.Latitude, l.Longitude)
	case backend.Image, backend.Sticker, backend.Audio, backend.Video, backend.File:
		if len(msg.Media) == 0 {
			return nil, errors.New("WeChat media event has no attachment")
		}
		if msg.Kind == backend.Sticker {
			typ = event.EventSticker
		}
		for i, media := range msg.Media {
			data, err := c.readMedia(ctx, media)
			if err != nil {
				return nil, err
			}
			mime := media.MIME
			if mime == "" {
				mime = mimetype.Detect(data).String()
			}
			if msg.Kind == backend.Audio && (strings.Contains(mime, "silk") || strings.Contains(string(data[:min(len(data), 16)]), "#!SILK_V3")) {
				data, err = silkToOgg(ctx, data)
				if err != nil {
					return nil, err
				}
				mime = "audio/ogg"
				media.Name = "voice.ogg"
			}
			name := media.Name
			if name == "" {
				name = string(msg.Kind) + mimetype.Detect(data).Extension()
			}
			uri, file, err := intent.UploadMedia(ctx, portal.MXID, data, name, mime)
			if err != nil {
				return nil, err
			}
			part := &event.MessageEventContent{MsgType: matrixType(msg.Kind), Body: name, URL: uri, File: file, Info: &event.FileInfo{MimeType: mime, Size: len(data), Width: media.Width, Height: media.Height, Duration: media.DurationMS}}
			if msg.Text != "" {
				part.FileName = name
				part.Body = msg.Text
			}
			if msg.Kind == backend.Audio {
				part.MSC3245Voice = &event.MSC3245Voice{}
			}
			converted.Parts = append(converted.Parts, &bridgev2.ConvertedMessagePart{ID: networkid.PartID(strconv.Itoa(i)), Type: typ, Content: part})
		}
	case backend.Text, backend.Notice:
	default:
		content.MsgType = event.MsgNotice
		content.Body = fmt.Sprintf("Unsupported WeChat message (%s)", msg.Kind)
		if msg.Text != "" {
			content.Body += "\n" + msg.Text
		}
	}
	if len(converted.Parts) == 0 {
		converted.Parts = []*bridgev2.ConvertedMessagePart{{ID: "0", Type: typ, Content: content}}
	}
	for _, part := range converted.Parts {
		part.Content.Mentions = &event.Mentions{Room: msg.MentionAll}
		for _, userID := range msg.Mentions {
			ghost, err := c.connector.Bridge.GetGhostByID(ctx, networkid.UserID(userID))
			if err != nil {
				return nil, err
			}
			part.Content.Mentions.UserIDs = append(part.Content.Mentions.UserIDs, ghost.Intent.GetMXID())
		}
	}
	return converted, nil
}
func rawMessageID(id networkid.MessageID) (string, error) {
	_, encoded, ok := strings.Cut(string(id), ":")
	if !ok {
		return "", errors.New("invalid remote message ID")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	return string(decoded), err
}
func (c *Client) convertOutgoing(ctx context.Context, msg *bridgev2.MatrixMessage) (backend.Message, error) {
	content := msg.Content
	result := backend.Message{Kind: backend.Text, Text: content.Body}
	if content.Format == event.FormatHTML {
		parser := format.HTMLParser{PillConverter: func(name, mxid, eventID string, fctx format.Context) string { return name }, LinkConverter: func(text, href string, fctx format.Context) string {
			if text == href {
				return href
			}
			return text + " (" + href + ")"
		}}
		result.Text = parser.Parse(content.FormattedBody, format.NewContext(ctx))
	}
	switch content.MsgType {
	case event.MsgText, event.MsgNotice, event.MsgEmote:
	case event.MsgImage:
		result.Kind = backend.Image
	case event.MsgVideo:
		result.Kind = backend.Video
	case event.MsgAudio:
		result.Kind = backend.Audio
	case event.MsgFile:
		result.Kind = backend.File
	case event.MsgLocation:
		result.Kind = backend.LocationMessage
		raw := strings.TrimPrefix(content.GeoURI, "geo:")
		if raw == content.GeoURI {
			return result, errors.New("invalid Matrix geo URI")
		}
		coords := strings.Split(strings.SplitN(raw, ";", 2)[0], ",")
		if len(coords) < 2 {
			return result, errors.New("invalid Matrix geo URI")
		}
		lat, err := strconv.ParseFloat(coords[0], 64)
		if err != nil {
			return result, err
		}
		lon, err := strconv.ParseFloat(coords[1], 64)
		if err != nil {
			return result, err
		}
		if math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			return result, errors.New("invalid Matrix location")
		}
		result.Location = &backend.Location{Name: content.Body, Latitude: lat, Longitude: lon}
	default:
		return result, backend.ErrUnsupported
	}
	if msg.Event.Type == event.EventSticker {
		result.Kind = backend.Sticker
	}
	caps := c.session.Capabilities()
	if len(content.BeeperLinkPreviews) > 0 && result.Kind == backend.Text {
		p := content.BeeperLinkPreviews[0]
		result.Card = &backend.Card{Title: p.Title, Description: p.Description, Source: p.SiteName, URL: p.CanonicalURL}
		if caps.Supports(backend.CardMessage) {
			result.Kind = backend.CardMessage
		}
	}
	if !caps.Supports(result.Kind) {
		return result, backend.ErrUnsupported
	}
	if msg.ReplyTo != nil && caps.Replies {
		r, err := rawMessageID(msg.ReplyTo.ID)
		if err != nil {
			return result, err
		}
		result.ReplyTo = r
	}
	if content.Mentions != nil && caps.Mentions {
		result.MentionAll = content.Mentions.Room
		for _, mxid := range content.Mentions.UserIDs {
			if userID, ok := c.connector.Bridge.Matrix.ParseGhostMXID(mxid); ok {
				result.Mentions = append(result.Mentions, string(userID))
			} else if mxid == c.login.UserMXID {
				result.Mentions = append(result.Mentions, string(c.GetUserID()))
			}
		}
	}
	if result.Kind == backend.Image || result.Kind == backend.Sticker || result.Kind == backend.Video || result.Kind == backend.Audio || result.Kind == backend.File {
		info := content.Info
		if info != nil && int64(info.Size) > c.connector.Config.MaxMediaSize {
			return result, errors.New("Matrix attachment exceeds network.max_media_size")
		}
		uri := content.URL
		if content.File != nil {
			uri = content.File.URL
		}
		data, err := c.connector.Bridge.Bot.DownloadMedia(ctx, uri, content.File)
		if err != nil {
			return result, err
		}
		if int64(len(data)) > c.connector.Config.MaxMediaSize {
			return result, errors.New("Matrix attachment exceeds network.max_media_size")
		}
		media := backend.Media{Name: content.GetFileName(), Data: data, Size: int64(len(data)), MIME: mimetype.Detect(data).String()}
		if info != nil {
			media.Width = info.Width
			media.Height = info.Height
			media.DurationMS = info.Duration
		}
		result.Media = []backend.Media{media}
		result.Text = content.GetCaption()
	}
	return result, nil
}
func (c *Client) HandleMatrixMessageRemove(ctx context.Context, msg *bridgev2.MatrixMessageRemove) error {
	if !c.online.Load() {
		return backend.ErrDisconnected
	}
	if !c.session.Capabilities().Revoke {
		return backend.ErrUnsupported
	}
	target, err := rawMessageID(msg.TargetMessage.ID)
	if err != nil {
		return err
	}
	_, err = c.session.Send(ctx, backend.SendRequest{ChatID: string(msg.Portal.ID), TransactionID: string(msg.Event.ID), Message: backend.Message{Kind: backend.Revoke, TargetID: target}})
	return err
}

var _ bridgev2.RedactionHandlingNetworkAPI = (*Client)(nil)
