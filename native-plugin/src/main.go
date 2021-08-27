package main

import "C"

import (
	"context"
	// "flag"
	// "fmt"
	"log"
	"path/filepath"
	"time"
	"sync"

	// "k8s.io/apimachinery/pkg/api/errors"
	// metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"

	_ "k8s.io/client-go/plugin/pkg/client/auth"
)

var restClients map[uint64]*rest.RESTClient
var nextrestClient uint64
// var restClient *rest.RESTClient
var mtx sync.Mutex

//export Init
func Init() uint64 {
  mtx.Lock()
  defer mtx.Unlock()

	kubeconfig := ""
	contextName := ""
	if home := homedir.HomeDir(); home != "" {
		kubeconfig = filepath.Join(home, ".kube", "config")
	}

	config, err := clientcmd.BuildConfigFromFlags(contextName, kubeconfig)
	if err != nil {
		panic(err.Error())
	}

	config.NegotiatedSerializer = scheme.Codecs.WithoutConversion()

	restClient, err := rest.UnversionedRESTClientFor(config)
	if err != nil {
		panic(err.Error())
	}

	// // create the restClient
	// restClient, err := kubernetes.NewForConfig(config)
	// if err != nil {
	// 	panic(err.Error())
	// }

	// We made it, now register and stuff

	if restClients == nil {
		restClients = make(map[uint64]*rest.RESTClient)
	}

	restClientId := nextrestClient
	nextrestClient += 1

	restClients[restClientId] = restClient
	return restClientId
}

//export Submit
func Submit(csId uint64, arg uint64) uint64 {
  mtx.Lock()
  defer mtx.Unlock()

	restClient := restClients[csId]
	if restClient == nil {
		panic("unknown restClient")
	}

	// https://pkg.go.dev/k8s.io/client-go@v0.22.1/rest
	result := restClient.Verb("GET").
		RequestURI("/api/v1/namespaces/default/serviceaccounts?limit=500").
		Timeout(10*time.Second).
		Do(context.TODO())
	if result.Error() != nil {
		panic(result.Error())
	}
	log.Println("Overall result:", result)

	bytes, err := result.Raw()
	if err != nil {
		panic(err.Error())
	}
	log.Println("Raw response:", string(bytes))

	// pods, err := restClient.CoreV1().Pods("").List(context.TODO(), metav1.ListOptions{})
	// if err != nil {
	// 	panic(err.Error())
	// }
	// fmt.Printf("There are %d pods in the cluster\n", len(pods.Items))

	// // Examples for error handling:
	// // - Use helper functions like e.g. errors.IsNotFound()
	// // - And/or cast to StatusError and use its properties like e.g. ErrStatus.Message
	// namespace := "default"
	// pod := "example-xxxxx"
	// _, err = restClient.CoreV1().Pods(namespace).Get(context.TODO(), pod, metav1.GetOptions{})
	// if errors.IsNotFound(err) {
	// 	fmt.Printf("Pod %s in namespace %s not found\n", pod, namespace)
	// } else if statusError, isStatus := err.(*errors.StatusError); isStatus {
	// 	fmt.Printf("Error getting pod %s in namespace %s: %v\n",
	// 		pod, namespace, statusError.ErrStatus.Message)
	// } else if err != nil {
	// 	panic(err.Error())
	// } else {
	// 	fmt.Printf("Found pod %s in namespace %s\n", pod, namespace)
	// }

	return 25
}

func main() {}
