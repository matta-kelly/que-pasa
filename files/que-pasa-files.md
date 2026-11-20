---
type: component
description: "que-pasa's file store: where the images a tool makes for the person are kept, a bucket behind two calls, after LangChain's content and artifact and the Files APIs of OpenAI and Anthropic. Read for what a conversation keeps of an image and what the store keeps, the key layout, the three stores que-pasa ships, and what the deployment owns."
status: running
---
Where the images a tool makes for the person are kept: a bucket, behind two calls, which the deployment gives the runtime. The code is `files/`, exported as `@mku1tra/que-pasa/files`. A conversation keeps each image's link; the store keeps its bytes.
- [[#The pattern]] bytes in a bucket, a link in the conversation, served by id
- [[#The store]] two calls, and the key layout
- [[#The stores]] memory, a folder, an S3-compatible bucket
- [[#What the deployment owns]]

- [[que-pasa]]: the harness it is part of
- [[define-tool]]: how a tool gives images
- [[que-pasa-loop]]: how a call stores them, and the invariants
- [[que-pasa-server]]: the route that serves them

---
## The pattern

images from a tool: bytes in a bucket, a link in the conversation, served by id, as production systems keep files
- LangChain: a tool gives content for the model and an artifact for the app; its guidance keeps images out of graph state, a reference there and the bytes in object storage
- OpenAI and Anthropic: a tool's output files are stored server-side by id, and a client fetches them by id
- the link: `{ id, name, mediaType, size }`, in the tool result's `details`, pi's channel for UIs. Never the bytes, so a conversation's history reads light
- the bytes: in the store, at the image's key, with its type and name

## The store

- `FileStore`: `put(key, { data, mediaType, name })`, which replaces what is at the key, and `get(key)`, the file or undefined
- the key: `conversations/<pi's conversation id>/<file id>` (`fileKey`), the one place the layout lives
	- pi's id, never the client's key: a key is any string, and a deleted key is used again by a new conversation
	- the file id: a random UUID, so each file is one conversation's, and a conversation's images are one prefix, for a lifecycle rule or an erase
	- where the key goes in the bucket is the store's: `s3Files` puts it under its `prefix`, when it has one
- the types: PNG, JPEG, GIF and WebP (`imageTypes`). Not SVG, which can run script when served

## The stores

- `memoryFiles()`: in the process, for tests
- `folderFiles({ root })`: a folder on disk, a bucket for one server. A file's bytes at `<root>/<key>`, its type and name at `<key>.json`; each written to a temporary name, then renamed, the bytes last, so a crash never leaves half a file. A key that reaches outside the root is refused
- `s3Files({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix? })`: an S3-compatible bucket, path-style, so one shape reaches S3, Cloudflare R2, Garage and the rest. `PutObject` and `GetObject`, signed with SigV4 by `aws4fetch`; the type is the object's `Content-Type`, the name its `x-amz-meta-name`, URL-encoded, as S3 metadata is ASCII
	- `prefix`: the folder the store keeps its files under, for a bucket that other apps share. `landl-que` keeps a file at `landl-que/conversations/<id>/<file id>`; without one, at `conversations/<id>/<file id>`. Its slashes at the start and end are dropped; an empty part, `.` or `..` is refused
	- tested on Garage, which checks each signature, where podman is: the release's runner. With a prefix too: its files under it, apart from the bucket's root

## What the deployment owns

- which store, and its settings: the bucket, its endpoint, its keys and its prefix, given to `openRuntime({ files })`, as it gives pi's storage
- the bucket's rules: retention, backups, an erase
- who may read an image: the server serves one only to its conversation's caller, from the deployment's `authenticate`
- not built: images to the model, files that are not images, an erase of a deleted conversation's images, and clearing an image a crash left between its store and its result, which nothing links to
